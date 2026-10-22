/**
 * The rider app's figures — what a rider did, counted ONE way for Home,
 * History and Performance alike, so the three screens can never disagree.
 *
 * Pure on purpose (no `server-only`, no database, no clock of its own):
 * `scripts/qa/rider-insights.ts` runs it under tsx on plain rows. The data
 * layer (`data-access/rider-insights.ts`) reads rows and maps them; every
 * counting rule lives here.
 *
 * ## The one source: delivery events
 *
 * A rider's work is the `delivery_events` that name them (0081/0082): the
 * `accepted` event opens a STINT, `picked_up` stamps it, and one terminal event
 * closes it — `delivered`, `failed`, `cancelled`, or `reassigned` / `released`
 * (the job was taken from them or handed back: "reassigned away"). A stint is
 * the rider's hold on one delivery, so the same order accepted, released and
 * accepted again is two stints.
 *
 * A staff correction after the fact (delivered -> cancelled, ...) arrives as a
 * further terminal event with no `accepted` between: it REPLACES the stint's
 * outcome rather than adding a second one. A correction back to an active
 * status writes no event and is not visible here.
 *
 * ## Days are IST
 *
 * "Today's deliveries" counts stints ACCEPTED today; "Completed" counts stints
 * DELIVERED today; "Cancelled" counts today's accepted stints that ended
 * cancelled, failed or reassigned away. So a delivery accepted at 23:58 and
 * delivered at 00:10 is yesterday's delivery and today's completion — the same
 * answer on Home, in History and in the monthly report.
 *
 * ## Rates
 *
 * A rate with a zero denominator is `null` ("—" in the app), never 0 % or
 * 100 %. Rates are percentages 0–100 with one decimal.
 */
import {
  addDays,
  istDay,
  istDayStartIso,
  istWeekStart,
  type EarningRecord,
  type IncentiveProgress,
} from "@/lib/rider/earnings-math";

// ---------------------------------------------------------------------------
// the delivery status the app shows, and what comes next
// ---------------------------------------------------------------------------

export type RiderDeliveryStatus =
  | "accepted"
  | "arrived_pickup"
  | "picked_up"
  | "on_the_way"
  | "arrived_drop"
  | "delivered"
  | "failed"
  | "cancelled";

/** The spec's status table: `deliveries.status` plus the stamps (an ACTIVE delivery). */
export function riderDeliveryStatus(row: {
  status: string;
  arrived_pickup_at?: string | null;
  departed_pickup_at?: string | null;
  arrived_drop_at?: string | null;
}): RiderDeliveryStatus {
  if (row.status === "picked_up") {
    if (row.arrived_drop_at) return "arrived_drop";
    if (row.departed_pickup_at) return "on_the_way";
    return "picked_up";
  }
  return row.arrived_pickup_at ? "arrived_pickup" : "accepted";
}

const NEXT_STEP: Record<RiderDeliveryStatus, string> = {
  accepted: "Go to the shop",
  arrived_pickup: "Pick up the order",
  picked_up: "Start the trip",
  on_the_way: "Reach the customer",
  arrived_drop: "Hand over the order",
  delivered: "Done",
  failed: "Done",
  cancelled: "Done",
};

/** What the rider does next from this status, as a short English sentence. */
export function nextStepFor(status: RiderDeliveryStatus): string {
  return NEXT_STEP[status];
}

// ---------------------------------------------------------------------------
// events -> stints
// ---------------------------------------------------------------------------

export type Outcome = "delivered" | "failed" | "cancelled" | "reassigned";

/** The terminal event kinds, and the outcome each one means. */
export const TERMINAL_KINDS = ["delivered", "failed", "cancelled", "reassigned", "released"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

export function outcomeOfKind(kind: string): Outcome | null {
  switch (kind) {
    case "delivered":
    case "failed":
    case "cancelled":
      return kind;
    case "reassigned":
    case "released":
      return "reassigned";
    default:
      return null;
  }
}

/** The event kinds that mean the rider's hold ended in a delivery/failure/cancellation (not a loss of the job). */
const SETTLED: ReadonlySet<Outcome> = new Set<Outcome>(["delivered", "failed", "cancelled"]);

/** One `delivery_events` row that names the rider, in the shape the rules need. */
export interface EventFact {
  /** `delivery_events.id` (bigint identity; numeric order breaks timestamp ties). */
  id: number;
  deliveryId: string;
  orderId: string;
  kind: string;
  /** ISO instant (the row's `created_at`). */
  at: string;
  method: string | null;
  reason: string | null;
}

export interface Stint {
  deliveryId: string;
  orderId: string;
  /** Null when the stint began before the events we were given. */
  acceptedAt: string | null;
  pickedUpAt: string | null;
  /** Null while the delivery is still in the rider's hands. */
  endedAt: string | null;
  outcome: Outcome | null;
  /** The event that ended it (the history cursor and the dedupe key). */
  endEventId: number | null;
  /** The terminal event's `kind` (`reassigned` vs `released`). */
  endKind: string | null;
  method: string | null;
  reason: string | null;
}

/**
 * Microseconds since the epoch of a timestamptz string, to the digit PostgREST
 * returns ("2025-11-12T10:00:00.123456+00:00"). `Date.parse` alone stops at
 * milliseconds, which is not enough to keep a keyset cursor exact.
 */
export function micros(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Number.NaN;
  const m = /\.(\d{1,6})/.exec(iso);
  const frac = m ? Number(m[1].padEnd(6, "0")) : 0;
  return Math.floor(ms / 1000) * 1_000_000 + frac;
}

/** Chronological order, ties broken by id. */
function inOrder(a: EventFact, b: EventFact): number {
  const d = micros(a.at) - micros(b.at);
  return d !== 0 && !Number.isNaN(d) ? d : a.id - b.id;
}

/**
 * Stints from one rider's events (any number of deliveries, any order). Events
 * that are not accepted / picked_up / terminal are ignored.
 */
export function buildStints(events: EventFact[]): Stint[] {
  const byDelivery = new Map<string, EventFact[]>();
  for (const e of events) {
    const list = byDelivery.get(e.deliveryId);
    if (list) list.push(e);
    else byDelivery.set(e.deliveryId, [e]);
  }

  const out: Stint[] = [];
  for (const list of byDelivery.values()) {
    list.sort(inOrder);
    let open: Stint | null = null;
    let last: Stint | null = null;
    const begin = (e: EventFact, acceptedAt: string | null): Stint => {
      const s: Stint = {
        deliveryId: e.deliveryId,
        orderId: e.orderId,
        acceptedAt,
        pickedUpAt: null,
        endedAt: null,
        outcome: null,
        endEventId: null,
        endKind: null,
        method: null,
        reason: null,
      };
      out.push(s);
      return s;
    };
    const close = (s: Stint, e: EventFact, outcome: Outcome) => {
      s.endedAt = e.at;
      s.outcome = outcome;
      s.endEventId = e.id;
      s.endKind = e.kind;
      s.method = e.method;
      s.reason = e.reason;
    };

    for (const e of list) {
      if (e.kind === "accepted") {
        // A duplicate while one is open is the same hold.
        if (!open) {
          open = begin(e, e.at);
          last = open;
        }
      } else if (e.kind === "picked_up") {
        if (!open) {
          open = begin(e, null);
          last = open;
        }
        if (!open.pickedUpAt) open.pickedUpAt = e.at;
      } else {
        const outcome = outcomeOfKind(e.kind);
        if (!outcome) continue;
        if (open) {
          close(open, e, outcome);
          last = open;
          open = null;
        } else if (last && last.outcome && SETTLED.has(last.outcome) && SETTLED.has(outcome)) {
          // A staff correction: the later settled outcome replaces the earlier.
          close(last, e, outcome);
        } else {
          const s = begin(e, null);
          close(s, e, outcome);
          last = s;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Home: today's counts
// ---------------------------------------------------------------------------

export interface TodayFigures {
  /** Stints accepted today, any outcome. */
  deliveries: number;
  /** Stints delivered today. */
  completed: number;
  /** Today's accepted stints that ended cancelled, failed or reassigned away. */
  cancelled: number;
  /** ...of which failed. */
  failed: number;
}

/** Figures 1, 5 and 6 for the IST day `today`. */
export function todayFigures(stints: Stint[], today: string): TodayFigures {
  const f: TodayFigures = { deliveries: 0, completed: 0, cancelled: 0, failed: 0 };
  for (const s of stints) {
    if (s.acceptedAt && istDay(s.acceptedAt) === today) {
      f.deliveries++;
      if (s.outcome === "failed") {
        f.cancelled++;
        f.failed++;
      } else if (s.outcome === "cancelled" || s.outcome === "reassigned") {
        f.cancelled++;
      }
    }
    if (s.outcome === "delivered" && s.endedAt && istDay(s.endedAt) === today) f.completed++;
  }
  return f;
}

/** Stints delivered on IST days `from`..`to` inclusive. */
export function deliveredBetween(stints: Stint[], from: string, to: string): number {
  let n = 0;
  for (const s of stints) {
    if (s.outcome !== "delivered" || !s.endedAt) continue;
    const day = istDay(s.endedAt);
    if (day >= from && day <= to) n++;
  }
  return n;
}

/**
 * The incentive the rider is closest to: among the rules in force that are not
 * yet earned, the fewest deliveries still to go (ties: the larger bonus, then
 * the name). Null when there are none.
 */
export function nearestTarget(
  progress: Pick<IncentiveProgress, "name" | "done" | "target" | "bonus" | "earned">[]
): { name: string; done: number; target: number; bonus: number } | null {
  const open = progress.filter((p) => !p.earned && p.target > 0);
  if (open.length === 0) return null;
  const left = (p: (typeof open)[number]) => Math.max(p.target - p.done, 0);
  open.sort((a, b) => left(a) - left(b) || b.bonus - a.bonus || a.name.localeCompare(b.name));
  const best = open[0];
  return { name: best.name, done: best.done, target: best.target, bonus: best.bonus };
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/** Rounded to one decimal. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `num` as a percentage of `den`, one decimal; null when there is nothing to divide by. */
export function percent(num: number, den: number): number | null {
  return den > 0 ? round1((num / den) * 100) : null;
}

/** Mean minutes between pairs of ISO instants; negative or unreadable pairs are ignored. Null when none. */
export function averageMinutes(pairs: [string | null, string | null][]): number | null {
  let total = 0;
  let n = 0;
  for (const [from, to] of pairs) {
    if (!from || !to) continue;
    const ms = Date.parse(to) - Date.parse(from);
    if (!Number.isFinite(ms) || ms < 0) continue;
    total += ms;
    n++;
  }
  return n === 0 ? null : round1(total / n / 60_000);
}

export interface OfferFact {
  kind: "accepted" | "rejected" | "lapsed";
  at: string;
}

export interface ShiftFact {
  startedAt: string;
  /** Null while the shift is open (it runs until `now`). */
  endedAt: string | null;
}

/** Hours online inside [fromMs, toMs), an open shift counted until `nowMs`. Not rounded. */
export function onlineHours(shifts: ShiftFact[], fromMs: number, toMs: number, nowMs: number): number {
  let ms = 0;
  for (const s of shifts) {
    const start = Date.parse(s.startedAt);
    const end = s.endedAt ? Date.parse(s.endedAt) : nowMs;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const lo = Math.max(start, fromMs);
    const hi = Math.min(end, toMs, nowMs);
    if (hi > lo) ms += hi - lo;
  }
  return ms / 3_600_000;
}

/** `YYYY-MM` of an instant, IST. */
export function monthOf(at: string | Date): string {
  return istDay(at).slice(0, 7);
}

/** The month `n` before `month` (`YYYY-MM`), across year boundaries. */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** The last `count` months ending with the month of `today`, newest first. */
export function lastMonths(today: string, count = 12): string[] {
  const current = today.slice(0, 7);
  return Array.from({ length: count }, (_, i) => shiftMonth(current, -i));
}

/** The first day of a `YYYY-MM` month. */
const monthStartDay = (month: string) => `${month}-01`;

export interface PerformanceFigures {
  avgAcceptToDeliverMin: number | null;
  avgPickupToDeliverMin: number | null;
  acceptanceRate: number | null;
  failedRate: number | null;
  onlineHoursThisWeek: number;
}

/** Days the headline rates and averages look back over, today included. */
export const HEADLINE_DAYS = 30;

const inDays = (at: string | null, from: string, to: string) => {
  if (!at) return false;
  const d = istDay(at);
  return d >= from && d <= to;
};

/** Counts and averages over [from, to] IST days (stints by the day they ended, offers by their own day). */
function window(stints: Stint[], offers: OfferFact[], from: string, to: string) {
  const ended = stints.filter((s) => s.outcome && inDays(s.endedAt, from, to));
  const delivered = ended.filter((s) => s.outcome === "delivered");
  const failed = ended.filter((s) => s.outcome === "failed").length;
  const away = ended.filter((s) => s.outcome === "cancelled" || s.outcome === "reassigned").length;
  const inWindow = offers.filter((o) => inDays(o.at, from, to));
  const accepted = inWindow.filter((o) => o.kind === "accepted").length;
  return {
    delivered: delivered.length,
    failed,
    cancelled: away,
    avgAcceptToDeliverMin: averageMinutes(delivered.map((s) => [s.acceptedAt, s.endedAt])),
    avgPickupToDeliverMin: averageMinutes(delivered.map((s) => [s.pickedUpAt, s.endedAt])),
    acceptanceRate: percent(accepted, inWindow.length),
    failedRate: percent(failed, delivered.length + failed),
  };
}

/** The headline figures: the last 30 IST days, and this week's hours online. */
export function performanceFigures(
  stints: Stint[],
  offers: OfferFact[],
  shifts: ShiftFact[],
  now: Date
): PerformanceFigures {
  const today = istDay(now);
  const w = window(stints, offers, addDays(today, 1 - HEADLINE_DAYS), today);
  return {
    avgAcceptToDeliverMin: w.avgAcceptToDeliverMin,
    avgPickupToDeliverMin: w.avgPickupToDeliverMin,
    acceptanceRate: w.acceptanceRate,
    failedRate: w.failedRate,
    onlineHoursThisWeek: round1(
      onlineHours(shifts, Date.parse(istDayStartIso(istWeekStart(today))), now.getTime() + 1, now.getTime())
    ),
  };
}

export interface MonthRow {
  month: string;
  delivered: number;
  failed: number;
  cancelled: number;
  acceptanceRate: number | null;
  avgDeliverMin: number | null;
  earnings: number | null;
  onlineHours: number;
}

/**
 * The month-by-month report: the last 12 IST months, newest first. `money` maps
 * a month to its recorded ledger total, or is null when money is not shown.
 */
export function monthlyReport(
  stints: Stint[],
  offers: OfferFact[],
  shifts: ShiftFact[],
  now: Date,
  money: ReadonlyMap<string, number> | null,
  count = 12
): MonthRow[] {
  const today = istDay(now);
  return lastMonths(today, count).map((month) => {
    const from = monthStartDay(month);
    const to = addDays(monthStartDay(shiftMonth(month, 1)), -1);
    const w = window(stints, offers, from, to);
    return {
      month,
      delivered: w.delivered,
      failed: w.failed,
      cancelled: w.cancelled,
      acceptanceRate: w.acceptanceRate,
      avgDeliverMin: w.avgAcceptToDeliverMin,
      earnings: money ? (money.get(month) ?? null) : null,
      onlineHours: round1(
        onlineHours(
          shifts,
          Date.parse(istDayStartIso(from)),
          Date.parse(istDayStartIso(addDays(to, 1))),
          now.getTime()
        )
      ),
    };
  });
}

/**
 * Money recorded per IST month from the ledger's records. A month whose records
 * are all ₹0 (or absent) has no entry: ₹0 per-delivery rows are never money.
 */
export function monthlyMoney(records: Pick<EarningRecord, "date" | "amount">[]): Map<string, number> {
  const paise = new Map<string, number>();
  for (const r of records) {
    const m = r.date.slice(0, 7);
    paise.set(m, (paise.get(m) ?? 0) + Math.round(r.amount * 100));
  }
  const out = new Map<string, number>();
  for (const [m, p] of paise) if (p !== 0) out.set(m, p / 100);
  return out;
}

/**
 * Daily and weekly targets: the admin's default when it is above 0, else the
 * largest active incentive rule target for that period, else 0 (none shown).
 */
export function chooseTargets(
  settings: { daily: number; weekly: number },
  rules: Pick<IncentiveProgress, "period" | "target">[]
): { daily: number; weekly: number } {
  const largest = (period: "daily" | "weekly") =>
    rules.filter((r) => r.period === period).reduce((m, r) => Math.max(m, r.target), 0);
  const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return {
    daily: whole(settings.daily) || largest("daily"),
    weekly: whole(settings.weekly) || largest("weekly"),
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type HistoryOutcome = Outcome;
export const HISTORY_OUTCOMES: readonly HistoryOutcome[] = ["delivered", "failed", "cancelled", "reassigned"];

/** The terminal event kinds that make a history row of this outcome (all of them when none). */
export function historyKinds(outcome?: HistoryOutcome): TerminalKind[] {
  switch (outcome) {
    case "delivered":
      return ["delivered"];
    case "failed":
      return ["failed"];
    case "cancelled":
      return ["cancelled"];
    case "reassigned":
      return ["reassigned", "released"];
    default:
      return [...TERMINAL_KINDS];
  }
}

export type ProofKind = "code" | "photo" | "ops_approved" | "staff";

/** How a DELIVERED job was proved (`deliveries.delivery_method`); anything unknown is no proof. */
export function proofOf(method: string | null | undefined): ProofKind | null {
  return method === "code" || method === "photo" || method === "ops_approved" || method === "staff" ? method : null;
}

/**
 * A history row's reason. A failure keeps its text; a release is logged by the
 * database as `released:<why>:<exception id>` — turned into a sentence here so
 * a machine string never reaches the rider.
 */
export function historyReason(kind: string, raw: string | null): string | null {
  const text = raw?.trim() || null;
  if (kind !== "released") return kind === "reassigned" ? null : text;
  const why = /^released:([a-z_]+)/.exec(text ?? "")?.[1];
  return why === "go_offline" ? "Handed back when going offline" : "Handed back to dispatch";
}

/**
 * A timestamptz as PostgREST writes it ("2026-03-10T10:00:00.123456+00:00") and
 * a REAL instant: a cursor goes into a query filter, so anything Postgres would
 * refuse (a 30th of February, hour 25, trailing junk that JavaScript's lenient
 * parser forgives) must be refused here, as a 400, not discovered as a 500.
 */
export function isStrictTimestamp(at: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(at);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return false;
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && Number.isFinite(Date.parse(at));
}

/** A keyset cursor over (terminal event time, event id). Opaque to the app. */
export function encodeHistoryCursor(key: { at: string; id: number }): string {
  return Buffer.from(`${key.at}|${key.id}`, "utf8").toString("base64url");
}

export function decodeHistoryCursor(cursor: string): { at: string; id: number } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.lastIndexOf("|");
  if (sep < 1) return null;
  const at = raw.slice(0, sep);
  const id = Number(raw.slice(sep + 1));
  if (!Number.isSafeInteger(id) || id < 0 || !isStrictTimestamp(at)) {
    return null;
  }
  return { at, id };
}

/** Whether (at, id) comes strictly after the cursor in newest-first order, i.e. is OLDER than it. */
export function isAfterCursor(key: { at: string; id: number }, cursor: { at: string; id: number }): boolean {
  const d = micros(key.at) - micros(cursor.at);
  return d < 0 || (d === 0 && key.id < cursor.id);
}
