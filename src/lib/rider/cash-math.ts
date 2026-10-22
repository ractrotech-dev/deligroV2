import { addDays, istDay } from "@/lib/rider/earnings-math";

/**
 * The rider's cash position — pure, so the Cash screen's figures, the manager
 * queue's duplicate warning and the reminder rule are all one tested piece of
 * arithmetic (`data-access/rider-cash.ts` only reads rows and maps them).
 *
 * Definitions (consistent with the Manager branch's `ops_rider_cash_position`,
 * migration 0154: collected − confirmed rider_to_manager handovers):
 *
 *   collected   `deliveries.cod_collected_amount` for the rider, by the IST day
 *               of `cod_collected_at`. An online-paid order is never in it.
 *   deposited   `cod_handovers` rider_to_manager from the rider, by
 *               `handover_date`. A confirmed deposit IS such a row, so it is
 *               counted once, through the handover. A submitted, disputed or
 *               withdrawn deposit is not deposited.
 *   pending     collected − deposited, never below zero (0154 reads the same).
 *   awaiting    the rider's submitted-but-undecided deposits: shown, never
 *               subtracted from `pending` until a manager confirms.
 *
 * Cash collected for Deligro is not the rider's earnings and nothing here
 * touches the salary ledger (`earnings-math.ts`); only its day helpers are
 * shared.
 */

/** Days the Cash screen's day-by-day list reaches back. */
export const CASH_DAYS_SHOWN = 30;
/** Reminders go out at most this often per rider. */
export const REMINDER_EVERY_MS = 6 * 3_600_000;
/** The most one deposit may declare, in rupees: a typo guard well above any real shift. */
export const MAX_DEPOSIT = 1_000_000;

export type DayStatus = "settled" | "pending" | "disputed";

export interface RiderCashDay {
  /** IST `YYYY-MM-DD`. */
  day: string;
  collected: number;
  deposited: number;
  status: DayStatus;
  /** The manager's note on a disputed deposit made that day, when there is one. */
  note: string | null;
}

export interface RiderCashSummary {
  /** COD totals of the deliveries the rider holds (assigned or picked up), still to collect. */
  toCollect: number;
  collectedToday: number;
  depositedToday: number;
  collectedTotal: number;
  depositedTotal: number;
  /** collected − deposited, never below zero. */
  pending: number;
  /** Submitted deposits not yet decided; not subtracted from `pending`. */
  submittedAwaiting: number;
  /** When the oldest collection still undeposited was collected; null when nothing is pending. */
  oldestUndepositedAt: string | null;
  overLimit: boolean;
  overHours: boolean;
  /** The admin thresholds the two flags were judged against (0 = that rule is off). */
  limit: number;
  maxHours: number;
  days: RiderCashDay[];
}

export interface CashCollection {
  amount: number;
  /** ISO instant (`cod_collected_at`). */
  at: string;
}

export interface CashHandoverRow {
  amount: number;
  /** IST `YYYY-MM-DD` (`handover_date`). */
  day: string;
}

export interface CashDepositRow {
  status: "submitted" | "confirmed" | "disputed" | "withdrawn";
  amount: number;
  /** ISO instant. */
  createdAt: string;
  decisionNote: string | null;
}

export interface CashDisputeRow {
  day: string;
  status: "open" | "resolved";
}

export interface CashPositionInput {
  toCollect: number;
  collections: CashCollection[];
  /** The rider's rider_to_manager handovers, all time. */
  handovers: CashHandoverRow[];
  deposits: CashDepositRow[];
  disputes: CashDisputeRow[];
  /** `rider_cash_limit` (₹); 0 = no limit. */
  limit: number;
  /** `rider_cash_max_hours`; 0 = no limit. */
  maxHours: number;
}

const sum = <T>(rows: T[], pick: (row: T) => number): number => rows.reduce((total, row) => total + pick(row), 0);

/**
 * Collections oldest first; the first whose running total passes what has been
 * deposited is the oldest cash still in the rider's hand (deposits settle the
 * oldest cash first). Null when everything is covered.
 */
export function oldestUndeposited(collections: CashCollection[], depositedTotal: number): string | null {
  const ordered = [...collections].filter((c) => c.amount > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let running = 0;
  for (const c of ordered) {
    running += c.amount;
    if (running > depositedTotal) return c.at;
  }
  return null;
}

export function buildCashSummary(input: CashPositionInput, now: Date = new Date()): RiderCashSummary {
  const today = istDay(now);
  const collectedTotal = sum(input.collections, (c) => c.amount);
  const depositedTotal = sum(input.handovers, (h) => h.amount);
  const pending = Math.max(0, collectedTotal - depositedTotal);
  const submittedAwaiting = sum(
    input.deposits.filter((d) => d.status === "submitted"),
    (d) => d.amount
  );

  const collectedByDay = new Map<string, number>();
  for (const c of input.collections) {
    const day = istDay(c.at);
    collectedByDay.set(day, (collectedByDay.get(day) ?? 0) + c.amount);
  }
  const depositedByDay = new Map<string, number>();
  for (const h of input.handovers) depositedByDay.set(h.day, (depositedByDay.get(h.day) ?? 0) + h.amount);

  // A disputed deposit is attributed to the day it was made; its note is the
  // manager's, newest first when a day has several.
  const disputedNote = new Map<string, string | null>();
  for (const d of [...input.deposits].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    if (d.status !== "disputed") continue;
    const day = istDay(d.createdAt);
    if (!disputedNote.has(day)) disputedNote.set(day, d.decisionNote);
  }
  const openDisputeDays = new Set(input.disputes.filter((d) => d.status === "open").map((d) => d.day));

  const earliest = addDays(today, -(CASH_DAYS_SHOWN - 1));
  const dayKeys = new Set<string>([
    ...collectedByDay.keys(),
    ...depositedByDay.keys(),
    ...disputedNote.keys(),
    ...openDisputeDays,
  ]);
  const days: RiderCashDay[] = [...dayKeys]
    .filter((day) => day >= earliest && day <= today)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((day) => {
      // Settled: what the rider has deposited (to date) covers everything
      // collected up to the end of that day. Deposits settle the oldest cash
      // first, so a late deposit settles the earlier day it paid for.
      let collectedThrough = 0;
      for (const [d, amount] of collectedByDay) if (d <= day) collectedThrough += amount;
      const settled = depositedTotal >= collectedThrough;
      // An open dispute always shows. A disputed deposit shows until the day
      // is covered by deposits the managers confirmed.
      const disputed = openDisputeDays.has(day) || (disputedNote.has(day) && !settled);
      return {
        day,
        collected: collectedByDay.get(day) ?? 0,
        deposited: depositedByDay.get(day) ?? 0,
        status: disputed ? "disputed" : settled ? "settled" : "pending",
        note: disputedNote.get(day) ?? null,
      };
    });

  const oldestUndepositedAt = pending > 0 ? oldestUndeposited(input.collections, depositedTotal) : null;
  const overLimit = input.limit > 0 && pending > input.limit;
  const overHours =
    input.maxHours > 0 &&
    oldestUndepositedAt !== null &&
    now.getTime() - Date.parse(oldestUndepositedAt) >= input.maxHours * 3_600_000;

  return {
    toCollect: input.toCollect,
    collectedToday: collectedByDay.get(today) ?? 0,
    depositedToday: depositedByDay.get(today) ?? 0,
    collectedTotal,
    depositedTotal,
    pending,
    submittedAwaiting,
    oldestUndepositedAt,
    overLimit,
    overHours,
    limit: input.limit,
    maxHours: input.maxHours,
    days,
  };
}

/** What the rider may still declare: held cash less deposits already waiting for a decision. */
export function availableToDeclare(s: Pick<RiderCashSummary, "pending" | "submittedAwaiting">): number {
  return Math.max(0, s.pending - s.submittedAwaiting);
}

// ---------------------------------------------------------------------------
// declaring a deposit
// ---------------------------------------------------------------------------

export type DepositInputError = "invalid_amount" | "invalid_method" | "reference_required" | "exceeds_pending";

const REFERENCE_MAX = 64;

/**
 * The rider's declaration, checked against the cash they hold. Pure; the data
 * layer adds the photo and manager checks. A UPI deposit needs its reference;
 * a cash deposit drops any reference it was sent with.
 */
export function checkDeposit(
  input: { amount: unknown; method: unknown; reference?: unknown },
  position: Pick<RiderCashSummary, "pending" | "submittedAwaiting">
):
  | { ok: true; amount: number; method: "cash" | "upi"; reference: string | null }
  | { ok: false; error: DepositInputError; pending?: number; available?: number } {
  const { amount } = input;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_DEPOSIT) {
    return { ok: false, error: "invalid_amount" };
  }
  if (input.method !== "cash" && input.method !== "upi") return { ok: false, error: "invalid_method" };
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  if (input.method === "upi" && (reference === "" || reference.length > REFERENCE_MAX)) {
    return { ok: false, error: "reference_required" };
  }
  const available = availableToDeclare(position);
  if (amount > available) {
    return { ok: false, error: "exceeds_pending", pending: position.pending, available };
  }
  return { ok: true, amount, method: input.method, reference: input.method === "upi" ? reference : null };
}

// ---------------------------------------------------------------------------
// the manager's duplicate warning
// ---------------------------------------------------------------------------

export interface HandoverForDup {
  leg: string;
  fromUser: string | null;
  amount: number;
  /** IST `YYYY-MM-DD`. */
  handoverDate: string;
}

/**
 * What is already recorded as handed over by this rider on `day`: the manager
 * may have written the same handover directly on /manager/cash. The deposit
 * queue shows it, and confirming a deposit while it is above zero asks "Already
 * recorded ₹X today — confirm anyway?", so the same cash is never silently
 * counted twice.
 */
export function sameDayHandoverTotal(handovers: HandoverForDup[], riderId: string, day: string): number {
  return sum(
    handovers.filter((h) => h.leg === "rider_to_manager" && h.fromUser === riderId && h.handoverDate === day),
    (h) => h.amount
  );
}

// ---------------------------------------------------------------------------
// reminders
// ---------------------------------------------------------------------------

/** Why a rider is reminded, or null. The throttle is `reminderDue`. */
export function reminderReason(s: Pick<RiderCashSummary, "overLimit" | "overHours">): "limit" | "hours" | "both" | null {
  if (s.overLimit && s.overHours) return "both";
  if (s.overLimit) return "limit";
  if (s.overHours) return "hours";
  return null;
}

/** At most one reminder per rider every 6 hours. */
export function reminderDue(lastSentAt: string | null | undefined, now: Date): boolean {
  if (!lastSentAt) return true;
  const last = Date.parse(lastSentAt);
  return !Number.isFinite(last) || now.getTime() - last >= REMINDER_EVERY_MS;
}
