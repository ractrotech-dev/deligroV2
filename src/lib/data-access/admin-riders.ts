import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { getRiderAvailability, getRiderCode, isRiderSchemaPending } from "@/lib/data-access/rider-status";
import {
  EarningsInputError,
  getMoneySnapshot,
  getPendingByRider,
  listEarningRecords,
  listPayouts,
  type EarningRecord,
  type EarningsSummary,
} from "@/lib/data-access/rider-earnings";
import { riderPhase, type RiderAvailability } from "@/lib/rider/availability";
import { addDays, istDay, istDayStartIso, istWeekStart, parseRange } from "@/lib/rider/earnings-math";
import {
  previewPayout,
  type AdjustmentInput,
  type DbError,
  type PayoutInput,
  type PayoutPreview,
  type RuleInput,
} from "@/lib/rider/admin-money";
import { shortOrderId } from "@/lib/utils/order-map";

/**
 * The admin console's view of the riders: the Riders list, one rider's
 * Overview and Money tabs, and the writes behind the Money tab and the
 * incentive rules.
 *
 * ## Authorization
 *
 * Reads run on the service-role client, so each is the caller's to guard: every
 * page and action that reaches this module sits behind `requireRole("admin")`
 * (AGENTS.md rule 5). The WRITES take their client as an argument and are given
 * the admin's own cookie client, never the service role: `record_rider_payout`
 * checks `is_admin()` itself and the adjustment and rule policies check
 * `created_by = auth.uid()`, both of which only mean something when the
 * database can see who is asking. Nothing here would write under the service
 * role (the 0083 grants don't allow `record_rider_payout` to it at all).
 *
 * ## Before 0081 / 0083 are applied
 *
 * No database has them yet (ruling R2). The list and the Overview degrade to
 * the truth - nobody is online, no pending figure ("-", not ₹0: a ₹0 would be
 * a false statement about what a rider is owed) - and the Money tab and the
 * rules page throw `RiderSchemaPendingError` for the page to explain.
 */

type Db = Pick<SupabaseClient, "from" | "rpc">;
type PgError = { code?: string; message?: string };

const PAGE = 1000;
const MAX_PAGES = 100;

/** A table that may not exist yet reads as empty. */
async function pages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError | null }>,
  opts: { optional?: boolean } = {}
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const { data, error } = await page(n * PAGE, n * PAGE + PAGE - 1);
    if (error) {
      if (opts.optional && isMissingTable(error)) return [];
      throw error;
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error("admin riders read exceeded its page ceiling");
}

// ---------------------------------------------------------------------------
// the Riders list
// ---------------------------------------------------------------------------

export type RiderPhase = "offline" | "online" | "break" | "stale";

export interface AdminRiderRow {
  id: string;
  name: string | null;
  phone: string | null;
  riderCode: string | null;
  phase: RiderPhase;
  /** The rider's order in flight (assigned or picked up), if any. */
  activeOrderId: string | null;
  activeOrderCode: string | null;
  deliveredToday: number;
  /** Owed and unpaid, signed; null when the money tables (0083) are absent. */
  pending: number | null;
}

const PHASE_RANK: Record<RiderPhase, number> = { online: 0, stale: 1, break: 2, offline: 3 };

interface StatusRow {
  driver_id: string;
  is_online: boolean;
  break_until: string | null;
  online_since: string | null;
  last_fix_at: string | null;
}

/**
 * Every rider (`profiles.role = 'driver'`) with where they stand now: online,
 * on a break, online with a stale position, or offline; the order they are
 * carrying; today's deliveries (IST); and what they are owed.
 */
export async function listRidersForAdmin(now: Date = new Date()): Promise<AdminRiderRow[]> {
  const supabase = createAdminClient();
  const dayStart = istDayStartIso(istDay(now));

  const [riders, codes, statuses, inFlight, doneToday, pending] = await Promise.all([
    pages<{ id: string; full_name: string | null; phone: string | null }>((from, to) =>
      supabase
        .from("profiles")
        .select("id, full_name, phone")
        .eq("role", "driver")
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; full_name: string | null; phone: string | null }[]>()
    ),
    pages<{ driver_id: string; rider_code: string | null }>(
      (from, to) =>
        supabase
          .from("rider_profiles")
          .select("driver_id, rider_code")
          .order("driver_id")
          .range(from, to)
          .overrideTypes<{ driver_id: string; rider_code: string | null }[]>(),
      { optional: true }
    ),
    pages<StatusRow>(
      (from, to) =>
        supabase
          .from("rider_status")
          .select("driver_id, is_online, break_until, online_since, last_fix_at")
          .order("driver_id")
          .range(from, to)
          .overrideTypes<StatusRow[]>(),
      { optional: true }
    ),
    pages<{ id: string; driver_id: string; order_id: string }>((from, to) =>
      supabase
        .from("deliveries")
        .select("id, driver_id, order_id")
        .in("status", ["assigned", "picked_up"])
        .not("driver_id", "is", null)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; driver_id: string; order_id: string }[]>()
    ),
    pages<{ id: string; driver_id: string }>((from, to) =>
      supabase
        .from("deliveries")
        .select("id, driver_id")
        .eq("status", "delivered")
        .gte("delivered_at", dayStart)
        .not("driver_id", "is", null)
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: string; driver_id: string }[]>()
    ),
    getPendingByRider().catch((e: unknown) => {
      if (isRiderSchemaPending(e)) return null;
      throw e;
    }),
  ]);

  const codeOf = new Map(codes.map((c) => [c.driver_id, c.rider_code]));
  const statusOf = new Map(statuses.map((s) => [s.driver_id, s]));
  const orderOf = new Map(inFlight.map((d) => [d.driver_id, d.order_id]));
  const doneBy = new Map<string, number>();
  for (const d of doneToday) doneBy.set(d.driver_id, (doneBy.get(d.driver_id) ?? 0) + 1);

  const rows = riders.map((r): AdminRiderRow => {
    const s = statusOf.get(r.id);
    const availability: RiderAvailability = s?.is_online
      ? { isOnline: true, breakUntil: s.break_until, onlineSince: s.online_since, lastFixAt: s.last_fix_at }
      : { isOnline: false, breakUntil: null, onlineSince: null, lastFixAt: null };
    const orderId = orderOf.get(r.id) ?? null;
    return {
      id: r.id,
      name: r.full_name?.trim() || null,
      phone: r.phone,
      riderCode: codeOf.get(r.id) ?? null,
      phase: riderPhase(availability, now),
      activeOrderId: orderId,
      activeOrderCode: orderId ? `#${shortOrderId(orderId)}` : null,
      deliveredToday: doneBy.get(r.id) ?? 0,
      pending: pending === null ? null : (pending.get(r.id) ?? 0),
    };
  });

  return rows.sort(
    (a, b) =>
      PHASE_RANK[a.phase] - PHASE_RANK[b.phase] ||
      (a.name ?? "￿").localeCompare(b.name ?? "￿") ||
      a.id.localeCompare(b.id)
  );
}

// ---------------------------------------------------------------------------
// one rider: Overview
// ---------------------------------------------------------------------------

export interface AdminRiderDetail {
  id: string;
  name: string | null;
  phone: string | null;
  riderCode: string | null;
  joinedAt: string;
  phase: RiderPhase;
  onlineSince: string | null;
  lastFixAt: string | null;
  breakUntil: string | null;
  activeOrderId: string | null;
  activeOrderCode: string | null;
  delivered: { today: number; week: number; total: number };
  /** Owed and unpaid; null when the money tables (0083) are absent. */
  pending: number | null;
}

/** The rider, or null when this id is not a driver. */
export async function getRiderForAdmin(driverId: string, now: Date = new Date()): Promise<AdminRiderDetail | null> {
  const supabase = createAdminClient();
  const today = istDay(now);
  const delivered = (since?: string) => {
    let q = supabase
      .from("deliveries")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", driverId)
      .eq("status", "delivered");
    if (since) q = q.gte("delivered_at", istDayStartIso(since));
    return q;
  };

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, full_name, phone, created_at")
    .eq("id", driverId)
    .eq("role", "driver")
    .maybeSingle()
    .overrideTypes<{ id: string; full_name: string | null; phone: string | null; created_at: string }>();
  if (error) throw error;
  if (!profile) return null;

  const [riderCode, availability, active, todayCount, weekCount, totalCount, pending] = await Promise.all([
    getRiderCode(driverId),
    getRiderAvailability(driverId),
    supabase
      .from("deliveries")
      .select("order_id")
      .eq("driver_id", driverId)
      .in("status", ["assigned", "picked_up"])
      .order("id")
      .limit(1)
      .overrideTypes<{ order_id: string }[]>(),
    delivered(today),
    delivered(istWeekStart(today)),
    delivered(),
    getPendingByRider()
      .then((m) => m.get(driverId) ?? 0)
      .catch((e: unknown) => {
        if (isRiderSchemaPending(e)) return null;
        throw e;
      }),
  ]);
  for (const r of [active, todayCount, weekCount, totalCount]) if (r.error) throw r.error;

  const orderId = active.data?.[0]?.order_id ?? null;
  return {
    id: profile.id,
    name: profile.full_name?.trim() || null,
    phone: profile.phone,
    riderCode,
    joinedAt: profile.created_at,
    phase: riderPhase(availability, now),
    onlineSince: availability.onlineSince,
    lastFixAt: availability.lastFixAt,
    breakUntil: availability.breakUntil,
    activeOrderId: orderId,
    activeOrderCode: orderId ? `#${shortOrderId(orderId)}` : null,
    delivered: { today: todayCount.count ?? 0, week: weekCount.count ?? 0, total: totalCount.count ?? 0 },
    pending,
  };
}

// ---------------------------------------------------------------------------
// one rider: Money
// ---------------------------------------------------------------------------

/** Records per page of the Money tab's table. */
export const MONEY_PAGE_SIZE = 50;
/** The default window of the records table, in days (inclusive of today). */
const DEFAULT_WINDOW_DAYS = 31;

export interface RiderMoney {
  summary: EarningsSummary;
  /** Every unsettled record, any date: what a payout would draw from. */
  pending: EarningRecord[];
  records: EarningRecord[];
  nextCursor: string | null;
  /** The range the records cover (IST days). */
  range: { from: string; to: string };
  /** True when the requested range was malformed and the default is shown. */
  rangeFellBack: boolean;
  payouts: Awaited<ReturnType<typeof listPayouts>>;
  /** "This will settle ₹X (N items up to <date>)" - see `previewPayout`. */
  preview: (periodEnd: string) => PayoutPreview;
}

/**
 * Everything on a rider's Money tab. A malformed `from`/`to` falls back to the
 * last 31 days (and says so); a malformed cursor starts the list over.
 * Throws `RiderSchemaPendingError` before 0083.
 */
export async function getRiderMoney(
  driverId: string,
  q: { from?: string; to?: string; cursor?: string | null } = {},
  now: Date = new Date()
): Promise<RiderMoney> {
  const today = istDay(now);
  const asked = q.from !== undefined || q.to !== undefined ? parseRange(q.from, q.to) : null;
  const range = asked?.ok
    ? { from: asked.from, to: asked.to }
    : { from: addDays(today, -(DEFAULT_WINDOW_DAYS - 1)), to: today };

  const snapshot = getMoneySnapshot(driverId, now);
  const payouts = listPayouts(driverId);
  const records = listEarningRecords(
    driverId,
    { ...range, cursor: q.cursor ?? null, limit: MONEY_PAGE_SIZE },
    now
  ).catch((e: unknown) => {
    // A cursor that does not decode: start the list over rather than 500.
    if (q.cursor && e instanceof EarningsInputError) {
      return listEarningRecords(driverId, { ...range, limit: MONEY_PAGE_SIZE }, now);
    }
    throw e;
  });
  const [{ summary, pending }, paid, page] = await Promise.all([snapshot, payouts, records]);

  return {
    summary,
    pending,
    records: page.items,
    nextCursor: page.nextCursor,
    range,
    rangeFellBack: asked !== null && !asked.ok,
    payouts: paid,
    preview: (periodEnd) => previewPayout(pending, periodEnd),
  };
}

// ---------------------------------------------------------------------------
// writes - on the caller's own (cookie) client, never the service role
// ---------------------------------------------------------------------------

export type WriteResult = { ok: true; id: string } | { ok: false; error: DbError; notFound?: boolean };

/** Whether this id is a rider (a profile with role driver). */
export async function riderExists(driverId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("id")
    .eq("id", driverId)
    .eq("role", "driver")
    .maybeSingle()
    .overrideTypes<{ id: string }>();
  if (error) throw error;
  return data !== null;
}

/**
 * The order behind an 8-character code, among the deliveries THIS rider made:
 * a deduction or bonus "for order #X" must be for one of their orders.
 */
export async function resolveRiderOrder(driverId: string, code: string): Promise<string | null> {
  const rows = await pages<{ id: string; order_id: string }>((from, to) =>
    createAdminClient()
      .from("deliveries")
      .select("id, order_id")
      .eq("driver_id", driverId)
      .order("id")
      .range(from, to)
      .overrideTypes<{ id: string; order_id: string }[]>()
  );
  return rows.find((r) => shortOrderId(r.order_id) === code)?.order_id ?? null;
}

/**
 * One ledger entry. RLS requires `is_admin()` and `created_by = auth.uid()`,
 * so `adminId` is the signed-in admin's own id and `db` their cookie client.
 */
export async function insertAdjustment(
  db: Db,
  adminId: string,
  driverId: string,
  input: AdjustmentInput,
  orderId: string | null
): Promise<WriteResult> {
  const { data, error } = await db
    .from("rider_adjustments")
    .insert({
      driver_id: driverId,
      kind: input.kind,
      amount: input.amount,
      reason: input.reason,
      order_id: orderId,
      effective_on: input.effectiveOn,
      created_by: adminId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error };
  return { ok: true, id: String((data as { id: string }).id) };
}

/**
 * `record_rider_payout`: settles everything dated up to `periodEnd` that no
 * payout has settled. It checks `is_admin()` itself, so `db` must be the
 * admin's cookie client. The caller reads the payout row back for the amount
 * that was ACTUALLY recorded (`getPayout`): the preview can be stale.
 */
export async function recordPayout(db: Db, driverId: string, input: PayoutInput): Promise<WriteResult> {
  const { data, error } = await db.rpc("record_rider_payout", {
    p_driver: driverId,
    p_period_end: input.periodEnd,
    p_method: input.method,
    p_reference: input.reference,
    p_paid_on: input.paidOn,
    p_note: input.note,
  });
  if (error) return { ok: false, error };
  return { ok: true, id: String(data) };
}

/**
 * A new rule. `created_by` is the admin's own id (the insert policy requires
 * it). `period` and `starts_on` are written here and can never be changed.
 */
export async function createIncentiveRule(db: Db, adminId: string, v: RuleInput): Promise<WriteResult> {
  const { data, error } = await db
    .from("rider_incentive_rules")
    .insert({
      name: v.name,
      period: v.period,
      target_deliveries: v.targetDeliveries,
      bonus_amount: v.bonusAmount,
      window_start: v.windowStart,
      window_end: v.windowEnd,
      starts_on: v.startsOn,
      ends_on: v.endsOn,
      active: v.active,
      created_by: adminId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error };
  return { ok: true, id: String((data as { id: string }).id) };
}

/**
 * Edit a rule. Only the columns 0083 lets a client update are sent: never
 * `period` or `starts_on` (the grant leaves them out and the trigger refuses
 * them for every role), whatever the form held.
 */
export async function updateIncentiveRule(db: Db, id: string, v: RuleInput): Promise<WriteResult> {
  const { data, error } = await db
    .from("rider_incentive_rules")
    .update({
      name: v.name,
      target_deliveries: v.targetDeliveries,
      bonus_amount: v.bonusAmount,
      window_start: v.windowStart,
      window_end: v.windowEnd,
      ends_on: v.endsOn,
      active: v.active,
    })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error };
  // RLS turns a refused update into zero rows, not an error.
  if (!data || data.length === 0) return { ok: false, error: { message: "no row updated" }, notFound: true };
  return { ok: true, id };
}

/** Switch a rule on or off. Rules are deactivated, never deleted. */
export async function setIncentiveRuleActive(db: Db, id: string, active: boolean): Promise<WriteResult> {
  const { data, error } = await db.from("rider_incentive_rules").update({ active }).eq("id", id).select("id");
  if (error) return { ok: false, error };
  if (!data || data.length === 0) return { ok: false, error: { message: "no row updated" }, notFound: true };
  return { ok: true, id };
}
