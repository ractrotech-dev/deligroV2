import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError, getRiderCode } from "@/lib/data-access/rider-status";
import { notifyRiderIncentiveEarned } from "@/lib/notifications/order-events";
import { captureError } from "@/lib/obs/emit";
import { monthlyMoney } from "@/lib/rider/figures";
import {
  addDays,
  buildRecords,
  compareRecords,
  incentiveProgress,
  isZeroDelivery,
  istDay,
  istDayStartIso,
  istWeekStart,
  isDayKey,
  parseRange,
  reconcile,
  summarize,
  type AdjustmentKind,
  type EarningRecord,
  type EarningsSummary,
  type IncentiveProgress,
  type IncentiveRule,
  type Ledger,
  type LedgerAdjustment,
  type LedgerAward,
  type LedgerEarning,
  type LedgerPayout,
} from "@/lib/rider/earnings-math";

export type { EarningRecord, EarningsSummary, IncentiveProgress };

/**
 * A rider's money, read from the 0083 ledger: the Earnings tab's summary, the
 * records list, payouts, incentive progress and the date-wise statement; and
 * the push for a newly earned incentive.
 *
 * Every function takes the rider's id and trusts it, because every one runs on
 * the service-role client. The authorization is the caller's:
 * `/api/rider/earnings/*` derive the id from the session behind
 * `requireRiderApi()`; Task 3's admin screens behind `requireRole("admin")`.
 * Every ledger query is filtered `driver_id = <that id>` — nothing here reads
 * another rider's rows.
 *
 * The arithmetic is `lib/rider/earnings-math.ts` (pure, tested on fixtures that
 * mirror the 0083 proof). This file only reads rows and maps them.
 *
 * ## Before 0083 is applied
 *
 * Every read throws `RiderSchemaPendingError`,
 * which `riderRouteError` answers with 503 `migration_pending`. A ₹0 summary
 * would be a false statement about a rider's pay, so there is no degraded
 * answer here. `notifyNewIncentiveAwards` is the exception: it runs after a
 * delivery completes and must never affect it, so it does nothing.
 *
 * ## Volume
 *
 * The summary and statement read the rider's whole ledger, paged past
 * PostgREST's 1000-row cap. At a few dozen deliveries a day that is a few
 * thousand small rows a year per rider; 0083 offers no aggregate function to
 * push the sums into SQL, and the routes are rate-limited.
 */

/**
 * The 0083 tables are not in this database (yet). A plain
 * `RiderSchemaPendingError` (not a subclass: `rider-status` and this module
 * import each other through the delivery path, so nothing here may use its
 * exports while the modules load).
 */
function moneyPending(): RiderSchemaPendingError {
  return new RiderSchemaPendingError("migration_pending: the rider money tables (0083) are not applied");
}

/** A malformed query: the routes answer 400 with `code`. */
export class EarningsInputError extends Error {
  constructor(readonly code: "invalid_date" | "invalid_range" | "invalid_cursor") {
    super(code);
    this.name = "EarningsInputError";
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;
type PgError = { code?: string; message?: string };
type PageResult<T> = PromiseLike<{ data: T[] | null; error: PgError | null }>;

/** PostgREST's default `max-rows` on Supabase: a read asks for no more per page. */
const PAGE_SIZE = 1000;
/** A ceiling on paging, so a runaway can never turn one request into a table scan. */
const MAX_PAGES = 200;

function fail(error: PgError): never {
  if (isMissingTable(error)) throw moneyPending();
  throw error;
}

/** Every row a query returns, a page at a time. The query must have a total order. */
async function readAll<T>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const from = n * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) fail(error);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`rider ledger read exceeded ${MAX_PAGES * PAGE_SIZE} rows`);
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** A `date` column ("2025-11-11"), or a timestamp's date part. */
const dayOf = (v: unknown): string => String(v ?? "").slice(0, 10);

// ---------------------------------------------------------------------------
// rows -> ledger
// ---------------------------------------------------------------------------

const EARNING_COLUMNS =
  "id, delivery_id, order_id, earned_at, base_fee, distance_km, distance_source, billable_km, distance_fee, min_topup, tip_amount, tip_in_cash, amount, payout_id";
const AWARD_COLUMNS = "id, rule_id, amount, trigger_earning_id, awarded_at, payout_id";
const ADJUSTMENT_COLUMNS =
  "id, kind, amount, reason, order_id, effective_on, payout_id, reverses_earning_id, created_at";
const PAYOUT_COLUMNS = "id, amount, method, reference, paid_on, period_end, note, created_at";
const RULE_COLUMNS =
  "id, name, period, target_deliveries, bonus_amount, window_start, window_end, starts_on, ends_on, active";

interface EarningRow {
  id: string;
  delivery_id: string;
  order_id: string;
  earned_at: string;
  base_fee: number | string;
  distance_km: number | string;
  distance_source: string | null;
  billable_km: number | string;
  distance_fee: number | string;
  min_topup: number | string;
  tip_amount: number | string;
  tip_in_cash: boolean;
  amount: number | string;
  payout_id: string | null;
}
interface AwardRow {
  id: string;
  rule_id: string;
  amount: number | string;
  trigger_earning_id: string | null;
  awarded_at: string;
  payout_id: string | null;
}
interface AdjustmentRow {
  id: string;
  kind: AdjustmentKind;
  amount: number | string;
  reason: string;
  order_id: string | null;
  effective_on: string;
  payout_id: string | null;
  reverses_earning_id: string | null;
  created_at: string;
}
interface PayoutRow {
  id: string;
  amount: number | string;
  method: string;
  reference: string | null;
  paid_on: string;
  period_end: string;
  note: string | null;
  created_at: string;
}
interface RuleRow {
  id: string;
  name: string;
  period: "daily" | "weekly";
  target_deliveries: number;
  bonus_amount: number | string;
  window_start: string | null;
  window_end: string | null;
  starts_on: string;
  ends_on: string | null;
  active: boolean;
}

function toEarning(r: EarningRow): LedgerEarning {
  return {
    id: r.id,
    deliveryId: r.delivery_id,
    orderId: r.order_id,
    earnedAt: r.earned_at,
    baseFee: num(r.base_fee),
    distanceKm: num(r.distance_km),
    distanceSource: r.distance_source === "road" || r.distance_source === "estimate" ? r.distance_source : null,
    billableKm: num(r.billable_km),
    distanceFee: num(r.distance_fee),
    minTopup: num(r.min_topup),
    tipAmount: num(r.tip_amount),
    tipInCash: r.tip_in_cash === true,
    amount: num(r.amount),
    payoutId: r.payout_id,
  };
}

function toAdjustment(r: AdjustmentRow): LedgerAdjustment {
  return {
    id: r.id,
    kind: r.kind,
    amount: num(r.amount),
    reason: r.reason,
    orderId: r.order_id,
    effectiveOn: dayOf(r.effective_on),
    payoutId: r.payout_id,
    reversesEarningId: r.reverses_earning_id,
    createdAt: r.created_at,
  };
}

function toPayout(r: PayoutRow): LedgerPayout {
  return {
    id: r.id,
    amount: num(r.amount),
    method: r.method,
    reference: r.reference,
    paidOn: dayOf(r.paid_on),
    periodEnd: dayOf(r.period_end),
    note: r.note,
    createdAt: r.created_at,
  };
}

function toRule(r: RuleRow): IncentiveRule {
  return {
    id: r.id,
    name: r.name,
    period: r.period,
    targetDeliveries: num(r.target_deliveries),
    bonusAmount: num(r.bonus_amount),
    windowStart: r.window_start,
    windowEnd: r.window_end,
    startsOn: dayOf(r.starts_on),
    endsOn: r.ends_on ? dayOf(r.ends_on) : null,
    active: r.active === true,
  };
}

const chunks = <T>(xs: T[], size = 100): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** Names of the given rules (a rider's past awards may be under a rule since switched off). */
async function ruleNames(supabase: AdminClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(ids)])) {
    const { data, error } = await supabase
      .from("rider_incentive_rules")
      .select("id, name")
      .in("id", part)
      .overrideTypes<{ id: string; name: string }[]>();
    if (error) fail(error);
    for (const r of data ?? []) out.set(r.id, r.name);
  }
  return out;
}

/**
 * The rider's ledger. With `earnedFrom`/`earnedTo` (IST days) the earnings are
 * limited to that range — the bulk of the ledger — plus whichever earnings the
 * awards were triggered by (an award is dated by its earning). Awards,
 * adjustments and payouts are few and always read whole: an attached reversal
 * can be dated into a range from outside it (P3-R6).
 */
async function loadLedger(
  supabase: AdminClient,
  driverId: string,
  range: { earnedFrom?: string; earnedTo?: string } = {}
): Promise<Ledger> {
  const [earningRows, awardRows, adjustmentRows, payoutRows] = await Promise.all([
    readAll<EarningRow>((from, to) => {
      let q = supabase.from("rider_earnings").select(EARNING_COLUMNS).eq("driver_id", driverId);
      if (range.earnedFrom) q = q.gte("earned_at", istDayStartIso(range.earnedFrom));
      if (range.earnedTo) q = q.lt("earned_at", istDayStartIso(addDays(range.earnedTo, 1)));
      return q.order("earned_at").order("id").range(from, to).overrideTypes<EarningRow[]>();
    }),
    readAll<AwardRow>((from, to) =>
      supabase
        .from("rider_incentive_awards")
        .select(AWARD_COLUMNS)
        .eq("driver_id", driverId)
        .order("awarded_at")
        .order("id")
        .range(from, to)
        .overrideTypes<AwardRow[]>()
    ),
    readAll<AdjustmentRow>((from, to) =>
      supabase
        .from("rider_adjustments")
        .select(ADJUSTMENT_COLUMNS)
        .eq("driver_id", driverId)
        .order("effective_on")
        .order("id")
        .range(from, to)
        .overrideTypes<AdjustmentRow[]>()
    ),
    readAll<PayoutRow>((from, to) =>
      supabase
        .from("rider_payouts")
        .select(PAYOUT_COLUMNS)
        .eq("driver_id", driverId)
        .order("paid_on")
        .order("id")
        .range(from, to)
        .overrideTypes<PayoutRow[]>()
    ),
  ]);

  const earnings = earningRows.map(toEarning);
  const have = new Set(earnings.map((e) => e.id));
  const missing = [
    ...new Set(awardRows.map((a) => a.trigger_earning_id).filter((id): id is string => !!id && !have.has(id))),
  ];
  for (const part of chunks(missing)) {
    const { data, error } = await supabase
      .from("rider_earnings")
      .select(EARNING_COLUMNS)
      .eq("driver_id", driverId)
      .in("id", part)
      .overrideTypes<EarningRow[]>();
    if (error) fail(error);
    earnings.push(...(data ?? []).map(toEarning));
  }

  const names = awardRows.length > 0 ? await ruleNames(supabase, awardRows.map((a) => a.rule_id)) : new Map();
  const awards: LedgerAward[] = awardRows.map((a) => ({
    id: a.id,
    ruleId: a.rule_id,
    ruleName: names.get(a.rule_id) ?? null,
    amount: num(a.amount),
    triggerEarningId: a.trigger_earning_id,
    awardedAt: a.awarded_at,
    payoutId: a.payout_id,
  }));

  return {
    earnings,
    awards,
    adjustments: adjustmentRows.map(toAdjustment),
    payouts: payoutRows.map(toPayout),
  };
}

// ---------------------------------------------------------------------------
// the reads
// ---------------------------------------------------------------------------

/** The Earnings tab's figures as of `now` (IST calendar). See `EarningsSummary`. */
export async function getEarningsSummary(driverId: string, now: Date = new Date()): Promise<EarningsSummary> {
  const ledger = await loadLedger(createAdminClient(), driverId);
  return summarize(ledger, istDay(now));
}

const RECORD_KINDS = new Set<EarningRecord["kind"]>(["delivery", "incentive", "bonus", "adjustment", "deduction", "salary"]);
/** Records per page when the caller does not say, and the most it may ask for. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** Without a range, the records list covers the last 31 IST days. */
const DEFAULT_RANGE_DAYS = 31;

/**
 * A keyset cursor: the last record of the page (its date, kind and id), so a
 * record landing while the rider scrolls does not shift the next page.
 */
function encodeCursor(r: EarningRecord): string {
  return Buffer.from(`${r.date}|${r.kind}|${r.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Pick<EarningRecord, "date" | "kind" | "id"> {
  const raw = /^[A-Za-z0-9_-]{1,400}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  const [date, kind, ...rest] = raw.split("|");
  const id = rest.join("|");
  if (!isDayKey(date) || !RECORD_KINDS.has(kind as EarningRecord["kind"]) || !id) {
    throw new EarningsInputError("invalid_cursor");
  }
  return { date, kind: kind as EarningRecord["kind"], id };
}

/**
 * The rider's records in `from`..`to` (IST days, both or neither; neither =
 * the last 31 days), newest first, `limit` per page (1–100, default 50).
 * `nextCursor` is null on the last page.
 *
 * `hideZeroDeliveries` (default true, P3-R11): a salaried fleet's deliveries
 * earn ₹0, which is not pay, so those rows (and the ₹0 reversal of one) are
 * left out. They move no money, so nothing else changes. Pass false for the
 * raw ledger.
 */
export async function listEarningRecords(
  driverId: string,
  q: { from?: string; to?: string; cursor?: string | null; limit?: number; hideZeroDeliveries?: boolean },
  now: Date = new Date()
): Promise<{ items: EarningRecord[]; nextCursor: string | null }> {
  let from: string;
  let to: string;
  if (q.from === undefined && q.to === undefined) {
    to = istDay(now);
    from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  } else if (q.from === undefined || q.to === undefined) {
    throw new EarningsInputError("invalid_range");
  } else {
    const range = parseRange(q.from, q.to);
    if (!range.ok) throw new EarningsInputError(range.error);
    ({ from, to } = range);
  }
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const limit =
    Number.isInteger(q.limit) && (q.limit as number) > 0 ? Math.min(q.limit as number, MAX_LIMIT) : DEFAULT_LIMIT;

  const ledger = await loadLedger(createAdminClient(), driverId, { earnedFrom: from, earnedTo: to });
  let records = buildRecords(ledger).filter((r) => r.date >= from && r.date <= to);
  if (q.hideZeroDeliveries ?? true) records = records.filter((r) => !isZeroDelivery(r));
  if (after) {
    const key = after as EarningRecord; // compareRecords reads date, kind and id only
    records = records.filter((r) => compareRecords(r, key) > 0);
  }
  const items = records.slice(0, limit);
  return {
    items,
    nextCursor: records.length > limit ? encodeCursor(items[items.length - 1]) : null,
  };
}

/**
 * How many ledger rows each of this rider's payouts settled. ₹0 rows (the
 * salaried fleet's per-delivery earnings, and their ₹0 reversals) are attached
 * but not counted: they are not something the operator settled, and the
 * payout preview does not list them either. No other row can be ₹0.
 */
async function attachedCounts(supabase: AdminClient, driverId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const tables = ["rider_earnings", "rider_incentive_awards", "rider_adjustments"] as const;
  const lists = await Promise.all(
    tables.map((table) =>
      readAll<{ id: string; payout_id: string }>((from, to) =>
        supabase
          .from(table)
          .select("id, payout_id")
          .eq("driver_id", driverId)
          .not("payout_id", "is", null)
          .neq("amount", 0)
          .order("id")
          .range(from, to)
          .overrideTypes<{ id: string; payout_id: string }[]>()
      )
    )
  );
  for (const rows of lists) {
    for (const r of rows) counts.set(r.payout_id, (counts.get(r.payout_id) ?? 0) + 1);
  }
  return counts;
}

/** The rider's payouts, newest first, with the number of rows each settled. */
export async function listPayouts(driverId: string): Promise<
  { id: string; amount: number; method: string; reference: string | null; paidOn: string; periodEnd: string; items: number }[]
> {
  const supabase = createAdminClient();
  const [rows, counts] = await Promise.all([
    readAll<PayoutRow>((from, to) =>
      supabase
        .from("rider_payouts")
        .select(PAYOUT_COLUMNS)
        .eq("driver_id", driverId)
        .order("paid_on", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
        .overrideTypes<PayoutRow[]>()
    ),
    attachedCounts(supabase, driverId),
  ]);
  return rows.map(toPayout).map((p) => ({
    id: p.id,
    amount: p.amount,
    method: p.method,
    reference: p.reference,
    paidOn: p.paidOn,
    periodEnd: p.periodEnd,
    items: counts.get(p.id) ?? 0,
  }));
}

/**
 * Progress on every active rule in force today: this period's count of the
 * rider's live deliveries (the trigger's own count), the target, the bonus,
 * the window and whether this period's award is already earned. Rules are read
 * verbatim, in the order the admin created them.
 */
export async function getIncentiveProgress(driverId: string, now: Date = new Date()): Promise<IncentiveProgress[]> {
  const supabase = createAdminClient();
  const today = istDay(now);
  const weekStart = istWeekStart(today);
  const [rules, earnings, reversals, awards] = await Promise.all([
    readAll<RuleRow>((from, to) =>
      supabase
        .from("rider_incentive_rules")
        .select(RULE_COLUMNS)
        .eq("active", true)
        .order("created_at")
        .order("id")
        .range(from, to)
        .overrideTypes<RuleRow[]>()
    ),
    // A daily period is today and a weekly one this week: nothing older counts.
    readAll<{ id: string; earned_at: string }>((from, to) =>
      supabase
        .from("rider_earnings")
        .select("id, earned_at")
        .eq("driver_id", driverId)
        .gte("earned_at", istDayStartIso(weekStart))
        .order("earned_at")
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; earned_at: string }[]>()
    ),
    readAll<{ id: string; reverses_earning_id: string }>((from, to) =>
      supabase
        .from("rider_adjustments")
        .select("id, reverses_earning_id")
        .eq("driver_id", driverId)
        .not("reverses_earning_id", "is", null)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; reverses_earning_id: string }[]>()
    ),
    readAll<{ id: string; rule_id: string; period_start: string }>((from, to) =>
      supabase
        .from("rider_incentive_awards")
        .select("id, rule_id, period_start")
        .eq("driver_id", driverId)
        .gte("period_start", weekStart)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; rule_id: string; period_start: string }[]>()
    ),
  ]);
  return incentiveProgress(
    rules.map(toRule),
    earnings.map((e) => ({ id: e.id, earnedAt: e.earned_at })),
    new Set(reversals.map((r) => r.reverses_earning_id)),
    awards.map((a) => ({ ruleId: a.rule_id, periodStart: dayOf(a.period_start) })),
    today
  );
}

/**
 * What the rider's incentive awards are worth for periods that began on or
 * after `sinceDay` (an IST day; pass the Monday of this week for "this week"):
 * the Home dashboard's "incentives earned". Exact to the paisa.
 */
export async function getIncentivesSince(driverId: string, sinceDay: string): Promise<number> {
  const supabase = createAdminClient();
  const rows = await readAll<{ id: string; amount: number | string }>((from, to) =>
    supabase
      .from("rider_incentive_awards")
      .select("id, amount")
      .eq("driver_id", driverId)
      .gte("period_start", sinceDay)
      .order("id")
      .range(from, to)
      .overrideTypes<{ id: string; amount: number | string }[]>()
  );
  return rows.reduce((p, r) => p + Math.round(num(r.amount) * 100), 0) / 100;
}

/**
 * The money recorded in each IST month (`YYYY-MM`) between the days `from` and
 * `to`: the signed total of the ledger's records dated in the month
 * (deliveries, incentives, bonuses, salary, adjustments, deductions). A month
 * that nets to ₹0 has no entry - per-delivery ₹0 rows are not money.
 */
export async function getMonthlyMoney(driverId: string, from: string, to: string): Promise<Map<string, number>> {
  const ledger = await loadLedger(createAdminClient(), driverId, { earnedFrom: from, earnedTo: to });
  return monthlyMoney(buildRecords(ledger).filter((r) => r.date >= from && r.date <= to));
}

/** Oldest day first (the order a statement is read in); within a day, the records' usual order. */
function chronological(a: EarningRecord, b: EarningRecord): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return compareRecords(a, b);
}

/**
 * The statement for `from`..`to` (IST days, ≤ 366): who it is for, the four
 * totals (opening pending + earned − paid = closing pending, see
 * `reconcile`) and every record dated in the range, oldest first, each with
 * its own paid/pending state and settlement reference. ₹0 delivery rows (a
 * salaried fleet, P3-R11) are left out of `rows`; the totals are worked out
 * from every record, and ₹0 rows add nothing to them, so the rows shown still
 * add up to `earned`.
 */
export async function getStatement(
  driverId: string,
  from: string,
  to: string
): Promise<{
  riderCode: string | null;
  name: string | null;
  from: string;
  to: string;
  openingPending: number;
  earned: number;
  paid: number;
  closingPending: number;
  rows: EarningRecord[];
}> {
  const range = parseRange(from, to);
  if (!range.ok) throw new EarningsInputError(range.error);
  const supabase = createAdminClient();
  const [ledger, riderCode, profile] = await Promise.all([
    loadLedger(supabase, driverId),
    getRiderCode(driverId),
    supabase
      .from("profiles")
      .select("full_name")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null }>(),
  ]);
  if (profile.error) {
    // The statement is still true without a name; the failure is not silent.
    captureError(profile.error, {
      source: "rider-earnings/statement",
      driverId,
      attrs: { event: "statement_profile_read_failed" },
    });
  }
  const records = buildRecords(ledger);
  const totals = reconcile(records, ledger.payouts, range.from, range.to);
  if (!totals.balanced) {
    // The ledger contradicts itself (a payout whose amount is not the sum of
    // what it attached). Still answered — the rows are true — but loudly.
    captureError(new Error("rider_statement_unbalanced"), {
      source: "rider-earnings/statement",
      driverId,
      attrs: { event: "rider_statement_unbalanced", from: range.from, to: range.to, ...totals },
    });
  }
  const rows = records
    .filter((r) => r.date >= range.from && r.date <= range.to && !isZeroDelivery(r))
    .sort(chronological);
  return {
    riderCode,
    name: profile.data?.full_name?.trim() || null,
    from: range.from,
    to: range.to,
    openingPending: totals.openingPending,
    earned: totals.earned,
    paid: totals.paid,
    closingPending: totals.closingPending,
    rows,
  };
}

// ---------------------------------------------------------------------------
// the admin console's reads (Task 3)
// ---------------------------------------------------------------------------

/**
 * A rider's Money tab figures and every record not yet settled (any date), from
 * one read of the ledger. The pending records feed the payout preview.
 */
export async function getMoneySnapshot(
  driverId: string,
  now: Date = new Date()
): Promise<{ summary: EarningsSummary; pending: EarningRecord[] }> {
  const ledger = await loadLedger(createAdminClient(), driverId);
  return {
    summary: summarize(ledger, istDay(now)),
    pending: buildRecords(ledger).filter((r) => r.status === "pending"),
  };
}

/**
 * What each rider is owed and has not been paid: the signed sum of their
 * unattached earnings, awards and adjustments (the same figure as
 * `EarningsSummary.pending`). A rider with nothing unsettled has no entry.
 */
export async function getPendingByRider(): Promise<Map<string, number>> {
  const supabase = createAdminClient();
  type Unpaid = { driver_id: string; amount: number | string; kind?: string };
  const unpaid = (table: string, columns: string) =>
    readAll<Unpaid>((from, to) =>
      supabase
        .from(table)
        .select(columns)
        .is("payout_id", null)
        .order("id")
        .range(from, to)
        .overrideTypes<Unpaid[]>()
    );
  const [earnings, awards, adjustments] = await Promise.all([
    unpaid("rider_earnings", "id, driver_id, amount"),
    unpaid("rider_incentive_awards", "id, driver_id, amount"),
    unpaid("rider_adjustments", "id, driver_id, kind, amount"),
  ]);
  const paise = new Map<string, number>();
  const add = (driver: string, rupees: number) =>
    paise.set(driver, (paise.get(driver) ?? 0) + Math.round(rupees * 100));
  for (const r of earnings) add(r.driver_id, num(r.amount));
  for (const r of awards) add(r.driver_id, num(r.amount));
  for (const r of adjustments) add(r.driver_id, r.kind === "deduction" ? -num(r.amount) : num(r.amount));
  return new Map([...paise].map(([driver, p]) => [driver, p / 100]));
}

/** Every incentive rule, active or not, with how many awards it has made (a rule with any is never deleted). */
export async function listIncentiveRules(): Promise<(IncentiveRule & { awards: number })[]> {
  const supabase = createAdminClient();
  const [rules, awards] = await Promise.all([
    readAll<RuleRow>((from, to) =>
      supabase
        .from("rider_incentive_rules")
        .select(RULE_COLUMNS)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
        .overrideTypes<RuleRow[]>()
    ),
    readAll<{ id: string; rule_id: string }>((from, to) =>
      supabase
        .from("rider_incentive_awards")
        .select("id, rule_id")
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; rule_id: string }[]>()
    ),
  ]);
  const counts = new Map<string, number>();
  for (const a of awards) counts.set(a.rule_id, (counts.get(a.rule_id) ?? 0) + 1);
  return rules.map((r) => ({ ...toRule(r), awards: counts.get(r.id) ?? 0 }));
}

/** One rule, or null. */
export async function getIncentiveRule(id: string): Promise<IncentiveRule | null> {
  const { data, error } = await createAdminClient()
    .from("rider_incentive_rules")
    .select(RULE_COLUMNS)
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<RuleRow>();
  if (error) fail(error);
  return data ? toRule(data) : null;
}

/**
 * A payout as the database recorded it, with the number of ledger rows it
 * settled (₹0 rows not counted, see `attachedCounts`). Read back after `record_rider_payout` so the operator sees the
 * amount that was actually paid, not the preview they clicked on.
 */
export async function getPayout(
  driverId: string,
  payoutId: string
): Promise<{ id: string; amount: number; method: string; reference: string | null; paidOn: string; periodEnd: string; items: number } | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("rider_payouts")
    .select(PAYOUT_COLUMNS)
    .eq("id", payoutId)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<PayoutRow>();
  if (error) fail(error);
  if (!data) return null;
  const counts = await Promise.all(
    (["rider_earnings", "rider_incentive_awards", "rider_adjustments"] as const).map(async (table) => {
      const { count, error: countError } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("payout_id", payoutId)
        .neq("amount", 0);
      if (countError) fail(countError);
      return count ?? 0;
    })
  );
  const p = toPayout(data);
  return {
    id: p.id,
    amount: p.amount,
    method: p.method,
    reference: p.reference,
    paidOn: p.paidOn,
    periodEnd: p.periodEnd,
    items: counts.reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------------------
// the incentive push
// ---------------------------------------------------------------------------

/** Awards pushed per call; anything beyond waits for the next delivery. */
const NOTIFY_BATCH = 10;

/**
 * Tell the rider about incentives they have just earned: every award with
 * `notified_at` null. Called after each completed delivery
 * (`completeDelivery`, ruling P3-R1), so ops-approved completions push too.
 *
 * Claim, then push: the stamp is a conditional update (`notified_at is null`),
 * and only the rows this call stamped are pushed. Two completions racing each
 * other therefore cannot push the same award twice; the cost is that a push
 * which fails after the claim is not retried — the award itself is in the
 * ledger either way, and pushes are best-effort everywhere.
 *
 * Never throws (it runs after the response, on `deferNotify`); before 0083 it
 * does nothing.
 */
export async function notifyNewIncentiveAwards(
  driverId: string,
  opts: { push?: (driverId: string, award: { name: string; amount: number }) => Promise<unknown> } = {}
): Promise<void> {
  const push = opts.push ?? notifyRiderIncentiveEarned;
  try {
    const supabase = createAdminClient();
    const { data: fresh, error } = await supabase
      .from("rider_incentive_awards")
      .select("id")
      .eq("driver_id", driverId)
      .is("notified_at", null)
      .order("awarded_at")
      .limit(NOTIFY_BATCH)
      .overrideTypes<{ id: string }[]>();
    if (error) {
      if (!isMissingTable(error)) {
        captureError(error, { source: "rider-earnings/notify-awards", driverId, attrs: { event: "award_read_failed" } });
      }
      return;
    }
    if (!fresh || fresh.length === 0) return;

    const { data: claimed, error: claimError } = await supabase
      .from("rider_incentive_awards")
      .update({ notified_at: new Date().toISOString() })
      .in(
        "id",
        fresh.map((a) => a.id)
      )
      .eq("driver_id", driverId)
      .is("notified_at", null)
      .select("id, rule_id, amount")
      .overrideTypes<{ id: string; rule_id: string; amount: number | string }[]>();
    if (claimError) {
      captureError(claimError, { source: "rider-earnings/notify-awards", driverId, attrs: { event: "award_claim_failed" } });
      return;
    }
    if (!claimed || claimed.length === 0) return;

    let names = new Map<string, string>();
    try {
      names = await ruleNames(supabase, claimed.map((a) => a.rule_id));
    } catch {
      // A push without the rule's name still says what was earned.
    }
    // One push at a time, each on its own: the stamps are already claimed, so a
    // push that throws must not drop the awards after it (they would never be
    // retried).
    for (const a of claimed) {
      try {
        await push(driverId, { name: names.get(a.rule_id) ?? "Incentive", amount: num(a.amount) });
      } catch (e) {
        captureError(e, {
          source: "rider-earnings/notify-awards",
          driverId,
          attrs: { event: "award_push_failed", awardId: a.id },
        });
      }
    }
  } catch (e) {
    captureError(e, { source: "rider-earnings/notify-awards", driverId, attrs: { event: "award_push_failed" } });
  }
}
