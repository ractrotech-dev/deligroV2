import { shortOrderId } from "@/lib/utils/order-map";

/**
 * Rider money, the pure half (Phase 3). No I/O: the data layer
 * (`lib/data-access/rider-earnings.ts`) reads the 0083 ledger and hands the
 * rows here; the QA script (`scripts/qa/rider-earnings.ts`) runs the same
 * functions on fixtures that mirror the 0083 proof.
 *
 * ## The salary model (ruling P3-R11)
 *
 * Deligro riders are paid a fixed salary outside the app, so this is a
 * recorded ledger (salary, bonuses, incentives, deductions, adjustments,
 * payouts), not a per-delivery pay formula. The 0083 rate card stays in the
 * database at ₹0, which makes every delivery earn ₹0: those rows still attach
 * to payouts and reverse like any other (they move no money), but nothing
 * presents them as pay - `isZeroDelivery` marks them for the screens that hide
 * them, and `perDeliveryAvg` is null when no live delivery paid anything.
 *
 * ## Two rules about where money is computed
 *
 * 1. **The database computes what a delivery earns.** `record_rider_earning`
 *    (0083) stores every component when a delivery becomes delivered. Nothing
 *    here mirrors that SQL any more (the offer estimate that did was removed
 *    with the salary model).
 * 2. **Every other figure is a sum of stored rows.** Nothing here recomputes
 *    an earning; it adds up what the ledger says.
 *
 * ## Dates
 *
 * Everything is cut on the IST calendar, as in the SQL (`at time zone
 * 'Asia/Kolkata'`): an earning is dated by the IST day of `earned_at`, an award
 * by the IST day of the earning that reached its target (`trigger_earning_id`),
 * an adjustment by `effective_on`. Weeks start on Monday. Days are
 * `YYYY-MM-DD` strings throughout, which compare correctly as strings.
 *
 * One exception, ruling P3-R6: a payout that attaches an earning also attaches
 * that earning's reversal even when the reversal is dated after the payout. A
 * row attached to a payout is therefore dated no later than the payout's
 * `paid_on` (`ledgerDate`). Without that, a statement would show a row as paid
 * by a payout made before the row's own date, and opening + earned − paid would
 * not equal closing (see `reconcile`).
 *
 * ## Money
 *
 * Sums are done in whole paise, so 0.1 + 0.2 never shows up on a statement.
 */

// ---------------------------------------------------------------------------
// the rate card (dormant) and money rounding
// ---------------------------------------------------------------------------

/**
 * `platform_settings` rider_base_fee / rider_km_included / rider_per_km /
 * rider_min_per_delivery (0083). Read and mapped so the columns stay known, but
 * dormant at ₹0 and no longer edited anywhere (P3-R11).
 */
export interface RateCard {
  baseFee: number;
  kmIncluded: number;
  perKm: number;
  minPerDelivery: number;
}

/**
 * Hundredths, rounded half away from zero - what a cast to `numeric(_,2)` does.
 * The tiny bias absorbs binary noise (1.005 * 100 = 100.49999...), which numeric
 * does not have.
 */
function hundredths(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const sign = x < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(x) * 100 + 1e-7);
}

/** Paise -> rupees. */
const rupees = (paise: number) => paise / 100;

// ---------------------------------------------------------------------------
// IST calendar on YYYY-MM-DD keys
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The IST calendar day of an instant (ISO string or Date). */
export function istDay(at: string | Date): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST wall-clock time of an instant, `HH:MM:SS`. */
function istTime(at: string | Date): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19);
}

/** A day key plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of the week containing `day` (weeks start Monday, as `date_trunc('week')`). */
export function istWeekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** The first of the month containing `day`. */
export function istMonthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

/** The first instant of an IST day, as ISO (UTC). */
export function istDayStartIso(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00+05:30`)).toISOString();
}

/** Whole days from `from` to `to` (0 = the same day). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** A real calendar day written exactly `YYYY-MM-DD`. */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The longest range a records or statement request may ask for, inclusive. */
const MAX_RANGE_DAYS = 366;

/**
 * A `from`..`to` range from a query string: both real `YYYY-MM-DD` days
 * (`invalid_date`), `from` not after `to` and at most 366 days inclusive — a
 * leap year — (`invalid_range`).
 */
export function parseRange(
  from: unknown,
  to: unknown
): { ok: true; from: string; to: string } | { ok: false; error: "invalid_date" | "invalid_range" } {
  if (!isDayKey(from) || !isDayKey(to)) return { ok: false, error: "invalid_date" };
  const span = daysBetween(from, to);
  if (span < 0 || span + 1 > MAX_RANGE_DAYS) return { ok: false, error: "invalid_range" };
  return { ok: true, from, to };
}

// ---------------------------------------------------------------------------
// the ledger, as the data layer hands it over
// ---------------------------------------------------------------------------

/** A `rider_earnings` row (0083). */
export interface LedgerEarning {
  id: string;
  deliveryId: string;
  orderId: string;
  /** ISO instant (`deliveries.delivered_at`). */
  earnedAt: string;
  baseFee: number;
  distanceKm: number;
  distanceSource: "road" | "estimate" | null;
  billableKm: number;
  distanceFee: number;
  minTopup: number;
  tipAmount: number;
  tipInCash: boolean;
  amount: number;
  payoutId: string | null;
}

/** A `rider_incentive_awards` row, with its rule's name. */
export interface LedgerAward {
  id: string;
  ruleId: string;
  ruleName: string | null;
  amount: number;
  triggerEarningId: string | null;
  /** ISO instant; dates the award only when its triggering earning is unknown. */
  awardedAt: string;
  payoutId: string | null;
}

export type AdjustmentKind = "bonus" | "adjustment" | "deduction" | "salary";

/** A `rider_adjustments` row. A deduction's amount is positive and subtracted. */
export interface LedgerAdjustment {
  id: string;
  kind: AdjustmentKind;
  amount: number;
  reason: string;
  orderId: string | null;
  /** `YYYY-MM-DD`. */
  effectiveOn: string;
  payoutId: string | null;
  /** Set on the reversal the database writes when a delivery leaves delivered (P3-R4). */
  reversesEarningId: string | null;
  createdAt: string;
}

/** A `rider_payouts` row. */
export interface LedgerPayout {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  /** `YYYY-MM-DD`. */
  paidOn: string;
  /** `YYYY-MM-DD`. */
  periodEnd: string;
  note: string | null;
  createdAt: string;
}

export interface Ledger {
  earnings: LedgerEarning[];
  awards: LedgerAward[];
  adjustments: LedgerAdjustment[];
  payouts: LedgerPayout[];
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/**
 * One line of a rider's money: every earning, award and adjustment is exactly
 * one record, so the records always add up to the ledger.
 *
 * - `amount` is the record's signed effect on what the rider is owed: a
 *   deduction record is negative, a reversal is negative, everything else is
 *   what it says. Summing `amount` over records never double counts.
 * - On a `delivery` record, `incentive` is the award(s) that delivery
 *   triggered and `deduction` the deductions recorded against its order.
 *   They are shown there for the rider's reading only — each is also its own
 *   record and is not in the delivery's `amount`. "This order, all in" is
 *   `amount + (incentive ?? 0) − (deduction ?? 0)`.
 * - `distanceSource` (ruling P3-R2): `road` (routed), `estimate` (straight
 *   line x 1.3) or null when no distance was recorded (`distanceKm` is 0).
 * - `reversed` (ruling P3-R4): a delivery record whose earning was reversed by
 *   a staff correction. It still shows; its reversal is an `adjustment`
 *   record with `reversesId` pointing back at it and the same order.
 * - `status` / `settledOn` / `reference`: the payout the row is attached to.
 * - `date`: the IST day the row belongs to — see "Dates" at the top for the
 *   P3-R6 rule on attached reversals.
 */
export interface EarningRecord {
  kind: "delivery" | "incentive" | "bonus" | "adjustment" | "deduction" | "salary";
  id: string;
  orderId: string | null;
  orderCode: string | null;
  date: string;
  baseFee: number | null;
  distanceKm: number | null;
  distanceSource: "road" | "estimate" | null;
  distanceFee: number | null;
  minTopup: number | null;
  tip: number | null;
  tipInCash: boolean | null;
  incentive: number | null;
  deduction: number | null;
  amount: number;
  status: "paid" | "pending";
  settledOn: string | null;
  reference: string | null;
  note: string | null;
  reversed: boolean;
  reversesId: string | null;
}

/** Whole paise of a rupee amount. */
const paise = (x: number) => hundredths(x);

/** Sum rupee amounts exactly. */
function sumMoney(values: Iterable<number>): number {
  let p = 0;
  for (const v of values) p += paise(v);
  return rupees(p);
}

/**
 * A per-delivery row that paid nothing: a delivery earning of ₹0 (the dormant
 * rate card), or the ₹0 reversal of one. It moves no money, so screens that list
 * records, statements and payout items leave it out; sums and reconciliation
 * are unaffected either way.
 */
export function isZeroDelivery(r: Pick<EarningRecord, "kind" | "amount" | "reversesId">): boolean {
  if (r.amount !== 0) return false;
  return r.kind === "delivery" || (r.kind === "adjustment" && r.reversesId !== null);
}

const orderCodeOf = (orderId: string | null) => (orderId ? `#${shortOrderId(orderId)}` : null);

const KIND_ORDER: Record<EarningRecord["kind"], number> = {
  delivery: 0,
  incentive: 1,
  bonus: 2,
  salary: 3,
  adjustment: 4,
  deduction: 5,
};

/** Newest first; within a day deliveries, then awards, then adjustments; then by id. */
export function compareRecords(a: EarningRecord, b: EarningRecord): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The day a ledger row belongs to: its own date, but no later than the
 * `paid_on` of the payout it is attached to (ruling P3-R6 — only an attached
 * reversal can be dated after its payout; every other attached row is dated
 * on or before `period_end <= paid_on`).
 */
function ledgerDate(own: string, payout: LedgerPayout | undefined): string {
  return payout && payout.paidOn < own ? payout.paidOn : own;
}

/** Every record of a ledger, newest first. */
export function buildRecords(ledger: Ledger): EarningRecord[] {
  const payouts = new Map(ledger.payouts.map((p) => [p.id, p]));
  const earnings = new Map(ledger.earnings.map((e) => [e.id, e]));
  const reversedIds = new Set(
    ledger.adjustments.map((j) => j.reversesEarningId).filter((id): id is string => id !== null)
  );

  const settle = (payoutId: string | null) => {
    const p = payoutId ? payouts.get(payoutId) : undefined;
    return {
      payout: p,
      status: p ? ("paid" as const) : ("pending" as const),
      settledOn: p?.paidOn ?? null,
      reference: p?.reference ?? null,
    };
  };

  // Awards ride on the earning that triggered them.
  const incentiveOn = new Map<string, number[]>();
  for (const a of ledger.awards) {
    if (a.triggerEarningId) {
      incentiveOn.set(a.triggerEarningId, [...(incentiveOn.get(a.triggerEarningId) ?? []), a.amount]);
    }
  }
  // Deductions ride on their order's record: the live earning, else the latest.
  const deliveryForOrder = new Map<string, LedgerEarning>();
  for (const e of ledger.earnings) {
    const held = deliveryForOrder.get(e.orderId);
    const better =
      !held ||
      (reversedIds.has(held.id) && !reversedIds.has(e.id)) ||
      (reversedIds.has(held.id) === reversedIds.has(e.id) && e.earnedAt > held.earnedAt);
    if (better) deliveryForOrder.set(e.orderId, e);
  }
  const deductionOn = new Map<string, number[]>();
  for (const j of ledger.adjustments) {
    if (j.kind !== "deduction" || !j.orderId) continue;
    const e = deliveryForOrder.get(j.orderId);
    if (e) deductionOn.set(e.id, [...(deductionOn.get(e.id) ?? []), j.amount]);
  }

  const blank = {
    baseFee: null,
    distanceKm: null,
    distanceSource: null,
    distanceFee: null,
    minTopup: null,
    tip: null,
    tipInCash: null,
    incentive: null,
    deduction: null,
    reversed: false,
    reversesId: null,
  } as const;

  const out: EarningRecord[] = [];
  for (const e of ledger.earnings) {
    const s = settle(e.payoutId);
    const inc = incentiveOn.get(e.id);
    const ded = deductionOn.get(e.id);
    out.push({
      ...blank,
      kind: "delivery",
      id: e.id,
      orderId: e.orderId,
      orderCode: orderCodeOf(e.orderId),
      date: ledgerDate(istDay(e.earnedAt), s.payout),
      baseFee: e.baseFee,
      distanceKm: e.distanceKm,
      distanceSource: e.distanceSource,
      distanceFee: e.distanceFee,
      minTopup: e.minTopup,
      tip: e.tipAmount,
      tipInCash: e.tipInCash,
      incentive: inc ? sumMoney(inc) : null,
      deduction: ded ? sumMoney(ded) : null,
      amount: e.amount,
      status: s.status,
      settledOn: s.settledOn,
      reference: s.reference,
      note: null,
      reversed: reversedIds.has(e.id),
    });
  }
  for (const a of ledger.awards) {
    const s = settle(a.payoutId);
    const trigger = a.triggerEarningId ? earnings.get(a.triggerEarningId) : undefined;
    out.push({
      ...blank,
      kind: "incentive",
      id: a.id,
      orderId: trigger?.orderId ?? null,
      orderCode: orderCodeOf(trigger?.orderId ?? null),
      date: ledgerDate(istDay(trigger?.earnedAt ?? a.awardedAt), s.payout),
      incentive: a.amount,
      amount: a.amount,
      status: s.status,
      settledOn: s.settledOn,
      reference: s.reference,
      note: a.ruleName,
    });
  }
  for (const j of ledger.adjustments) {
    const s = settle(j.payoutId);
    const isDeduction = j.kind === "deduction";
    out.push({
      ...blank,
      kind: j.kind,
      id: j.id,
      orderId: j.orderId,
      orderCode: orderCodeOf(j.orderId),
      date: ledgerDate(j.effectiveOn, s.payout),
      deduction: isDeduction ? j.amount : null,
      amount: isDeduction ? -j.amount : j.amount,
      status: s.status,
      settledOn: s.settledOn,
      reference: s.reference,
      note: j.reason,
      reversesId: j.reversesEarningId,
    });
  }
  return out.sort(compareRecords);
}

// ---------------------------------------------------------------------------
// the summary
// ---------------------------------------------------------------------------

/**
 * The Earnings tab's figures.
 *
 * - `today` / `week` / `month` / `total`: the signed sum of every ledger entry
 *   dated in the IST day, the week from Monday, the calendar month, and ever:
 *   delivery earnings, incentive awards, bonuses, salary, adjustments (signed)
 *   minus deductions. A reversed earning is left out (its reversal is too), so
 *   a corrected delivery simply stops counting. The breakdown figures below
 *   (incentives, bonuses, salary, adjustments, deductions) are all-time parts
 *   of the same entries.
 * - `perDeliveryAvg`: delivery earnings ÷ `deliveriesCounted` (live
 *   earnings), null with no deliveries and null when every live earning is ₹0
 *   (a salaried fleet: there is no per-delivery pay to average).
 * - `adjustments`: admin adjustments, signed; the system's reversals are not
 *   in it (they net against the earnings they reverse).
 * - `deductions`: a positive total, subtracted.
 * - `paid`: every payout. `pending`: every row not yet attached to a payout,
 *   signed — negative when deductions or reversals outweigh the rest (the
 *   honest balance; `record_rider_payout` refuses `nothing_to_pay` then).
 *
 * They net: total − paid = pending (the total already holds every entry).
 */
export interface EarningsSummary {
  today: number;
  week: number;
  month: number;
  total: number;
  perDeliveryAvg: number | null;
  deliveriesCounted: number;
  incentives: number;
  bonuses: number;
  adjustments: number;
  deductions: number;
  salary: number;
  paid: number;
  pending: number;
  lastPayout: { amount: number; paidOn: string; reference: string | null } | null;
}

/** The newest payout: latest `paid_on`, then latest recorded. */
function latestPayout(payouts: LedgerPayout[]): LedgerPayout | null {
  let best: LedgerPayout | null = null;
  for (const p of payouts) {
    if (!best || p.paidOn > best.paidOn || (p.paidOn === best.paidOn && p.createdAt > best.createdAt)) best = p;
  }
  return best;
}

/** The summary as of the IST day `today`. */
export function summarize(ledger: Ledger, today: string): EarningsSummary {
  const records = buildRecords(ledger);
  const week = istWeekStart(today);
  const month = istMonthStart(today);

  // Every ledger entry that still stands: a reversed earning and the reversal
  // that cancelled it are both out (they net to zero between them).
  const counted = records.filter((r) => !r.reversed && r.reversesId === null);
  const inPeriod = (from: string) =>
    sumMoney(counted.filter((r) => r.date >= from && r.date <= today).map((r) => r.amount));
  const live = records.filter((r) => r.kind === "delivery" && !r.reversed);
  const deliveryTotal = sumMoney(live.map((r) => r.amount));
  const ofKind = (kind: EarningRecord["kind"], pred: (r: EarningRecord) => boolean = () => true) =>
    sumMoney(records.filter((r) => r.kind === kind && pred(r)).map((r) => r.amount));
  const last = latestPayout(ledger.payouts);

  return {
    today: inPeriod(today),
    week: inPeriod(week),
    month: inPeriod(month),
    total: sumMoney(counted.map((r) => r.amount)),
    perDeliveryAvg: live.some((r) => r.amount !== 0) ? rupees(Math.round(paise(deliveryTotal) / live.length)) : null,
    deliveriesCounted: live.length,
    incentives: ofKind("incentive"),
    bonuses: ofKind("bonus"),
    adjustments: ofKind("adjustment", (r) => r.reversesId === null),
    // `0 -`, not unary minus: no deductions must read 0, not -0.
    deductions: 0 - ofKind("deduction"),
    salary: ofKind("salary"),
    paid: sumMoney(ledger.payouts.map((p) => p.amount)),
    pending: sumMoney(records.filter((r) => r.status === "pending").map((r) => r.amount)),
    lastPayout: last ? { amount: last.amount, paidOn: last.paidOn, reference: last.reference } : null,
  };
}

// ---------------------------------------------------------------------------
// the statement
// ---------------------------------------------------------------------------

/**
 * A statement's four totals for `from`..`to` (inclusive IST days):
 *
 *   openingPending  rows dated before `from` that no payout paid before `from` settled
 *   earned          rows dated in the range (signed)
 *   paid            payouts with `paid_on` in the range
 *   closingPending  rows dated up to `to` that no payout paid by `to` settled
 *
 * Opening and closing are counted row by row (each row's own paid/pending
 * state at that date), not derived from the other two — so `balanced`
 * (opening + earned − paid = closing) is a real check. It holds exactly when
 * every payout's amount is the sum of the rows attached to it (0083 proves
 * this for `record_rider_payout`) and no attached row is dated after its
 * payout's `paid_on`, which `buildRecords` guarantees for P3-R6's reversals.
 */
export function reconcile(
  records: Pick<EarningRecord, "amount" | "date" | "settledOn">[],
  payouts: Pick<LedgerPayout, "amount" | "paidOn">[],
  from: string,
  to: string
): { openingPending: number; earned: number; paid: number; closingPending: number; balanced: boolean } {
  const pendingAt = (day: string, inclusive: boolean) =>
    sumMoney(
      records
        .filter((r) => (inclusive ? r.date <= day : r.date < day))
        .filter((r) => !(r.settledOn !== null && (inclusive ? r.settledOn <= day : r.settledOn < day)))
        .map((r) => r.amount)
    );
  const openingPending = pendingAt(from, false);
  const closingPending = pendingAt(to, true);
  const earned = sumMoney(records.filter((r) => r.date >= from && r.date <= to).map((r) => r.amount));
  const paid = sumMoney(payouts.filter((p) => p.paidOn >= from && p.paidOn <= to).map((p) => p.amount));
  return {
    openingPending,
    earned,
    paid,
    closingPending,
    balanced: paise(openingPending) + paise(earned) - paise(paid) === paise(closingPending),
  };
}

// ---------------------------------------------------------------------------
// incentive progress
// ---------------------------------------------------------------------------

/** A `rider_incentive_rules` row. Times are IST `HH:MM[:SS]`. */
export interface IncentiveRule {
  id: string;
  name: string;
  period: "daily" | "weekly";
  targetDeliveries: number;
  bonusAmount: number;
  windowStart: string | null;
  windowEnd: string | null;
  startsOn: string;
  endsOn: string | null;
  active: boolean;
}

export interface IncentiveProgress {
  ruleId: string;
  name: string;
  period: "daily" | "weekly";
  target: number;
  done: number;
  bonus: number;
  /** "12:00–15:00" (IST), or null for all day. */
  window: string | null;
  endsOn: string | null;
  earned: boolean;
}

const hhmm = (t: string) => t.slice(0, 5);
/** `HH:MM` -> `HH:MM:00`, so it compares with `istTime` as a string. */
const hhmmss = (t: string) => (t.length === 5 ? `${t}:00` : t.slice(0, 8));

/**
 * Each active rule in force today, with how many of this rider's live
 * deliveries count towards it in the current period — the same count
 * `award_rider_incentives` (0083) makes: the IST day, or the IST week from
 * Monday, clipped to the rule's own dates, inside its window
 * `[window_start, window_end)`, reversed earnings left out. `earned` is
 * whether this period's award exists.
 */
export function incentiveProgress(
  rules: IncentiveRule[],
  earnings: Pick<LedgerEarning, "id" | "earnedAt">[],
  reversed: ReadonlySet<string>,
  awards: { ruleId: string; periodStart: string }[],
  today: string
): IncentiveProgress[] {
  const out: IncentiveProgress[] = [];
  const live = earnings
    .filter((e) => !reversed.has(e.id))
    .map((e) => ({ day: istDay(e.earnedAt), time: istTime(e.earnedAt) }));
  for (const r of rules) {
    if (!r.active || r.startsOn > today || (r.endsOn !== null && r.endsOn < today)) continue;
    const periodStart = r.period === "daily" ? today : istWeekStart(today);
    const periodEnd = r.period === "daily" ? today : addDays(periodStart, 6);
    const lo = r.startsOn > periodStart ? r.startsOn : periodStart;
    const hi = r.endsOn !== null && r.endsOn < periodEnd ? r.endsOn : periodEnd;
    const windowed = r.windowStart !== null && r.windowEnd !== null;
    const ws = windowed ? hhmmss(r.windowStart!) : "";
    const we = windowed ? hhmmss(r.windowEnd!) : "";
    const done = live.filter(
      (e) => e.day >= lo && e.day <= hi && (!windowed || (e.time >= ws && e.time < we))
    ).length;
    out.push({
      ruleId: r.id,
      name: r.name,
      period: r.period,
      target: r.targetDeliveries,
      done,
      bonus: r.bonusAmount,
      window: windowed ? `${hhmm(r.windowStart!)}–${hhmm(r.windowEnd!)}` : null,
      endsOn: r.endsOn,
      earned: awards.some((a) => a.ruleId === r.id && a.periodStart === periodStart),
    });
  }
  return out;
}
