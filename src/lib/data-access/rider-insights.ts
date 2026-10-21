import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { orderShortCode } from "@/lib/ops/order-contract";
import { encodeTimeCursor } from "@/lib/ops/rider-contract";
import { istDay, monthsOf, performanceOf, type FigureDelivery, type FigureEvent, type HistoryOutcome } from "@/lib/rider/figures";

/**
 * A rider's history and performance — the Rider plan's `rider-insights.ts`
 * (rider phase 4), created here first for the Manager app's rider screens with
 * the Rider plan's signatures; the Rider app's routes call the same functions.
 *
 * History comes from `ops_rider_history` (0153): every finished job, newest
 * first, keyset paged in the database. Performance runs `src/lib/rider/figures.ts`
 * over bounded windows.
 *
 * Service role. **The caller authorises first** (the rider's own session in the
 * Rider app; managerApiContext + the rider scope in the Manager app).
 */

export interface HistoryItem {
  orderId: string;
  code: string;
  shop: string;
  dropArea: string | null;
  outcome: HistoryOutcome;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  endedAt: string;
  distanceKm: number | null;
  /** The rider's earning for the job; null for salaried riders and for jobs that did not pay. */
  earning: number | null;
  reason: string | null;
  cancelledBy: string | null;
  proof: "code" | "photo" | "ops_approved" | "staff" | "vendor" | null;
  itemCount: number;
  orderValue: number;
}

interface HistoryRow {
  row_key: string;
  order_id: string;
  shop: string;
  drop_area: string | null;
  outcome: HistoryOutcome;
  accepted_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  ended_at: string;
  distance_km: number | string | null;
  reason: string | null;
  cancelled_by: string | null;
  proof: HistoryItem["proof"];
  item_count: number;
  order_value: number;
}

function toHistoryItem(r: HistoryRow, earning: number | null): HistoryItem {
  return {
    orderId: r.order_id,
    code: orderShortCode(r.order_id),
    shop: r.shop,
    dropArea: r.drop_area,
    outcome: r.outcome,
    acceptedAt: r.accepted_at,
    pickedUpAt: r.picked_up_at,
    deliveredAt: r.delivered_at,
    endedAt: new Date(r.ended_at).toISOString(),
    distanceKm: r.distance_km === null ? null : Number(r.distance_km),
    earning,
    reason: r.reason,
    cancelledBy: r.cancelled_by,
    proof: r.proof,
    itemCount: r.item_count,
    orderValue: r.order_value,
  };
}

async function historyRows(
  driverId: string,
  q: { from?: string | null; to?: string | null; outcome?: HistoryOutcome | null; cursor?: { at: string; id: string } | null },
  limit: number
): Promise<HistoryRow[]> {
  const { data, error } = await createAdminClient().rpc("ops_rider_history", {
    p_rider: driverId,
    p_from: q.from ?? null,
    p_to: q.to ?? null,
    p_outcome: q.outcome ?? null,
    p_before_at: q.cursor?.at ?? null,
    p_before_key: q.cursor?.id ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as HistoryRow[];
}

/** Earnings per order for the rider (empty for salaried riders, or before 0150). */
async function earningsFor(driverId: string, orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const { data, error } = await createAdminClient()
    .from("rider_earnings")
    .select("order_id, amount")
    .eq("driver_id", driverId)
    .in("order_id", orderIds);
  if (error) {
    if (isMissingTable(error)) return out;
    throw error;
  }
  for (const e of (data ?? []) as { order_id: string; amount: number | string }[]) out.set(e.order_id, Number(e.amount));
  return out;
}

/**
 * The rider's finished jobs, newest first. `limit` defaults to the Rider app's
 * page of 20; the Manager app asks for 50.
 */
export async function getRiderHistory(
  driverId: string,
  q: { from?: string; to?: string; outcome?: HistoryItem["outcome"]; cursor?: string | { at: string; id: string } | null; limit?: number }
): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  const cursor = typeof q.cursor === "string" ? null : (q.cursor ?? null);
  const rows = await historyRows(driverId, { from: q.from, to: q.to, outcome: q.outcome, cursor }, limit + 1);
  const page = rows.slice(0, limit);
  const earnings = await earningsFor(driverId, page.map((r) => r.order_id));
  const items = page.map((r) => toHistoryItem(r, r.outcome === "delivered" ? (earnings.get(r.order_id) ?? null) : null));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeTimeCursor(new Date(last.ended_at).toISOString(), last.row_key) : null,
  };
}

export async function getRiderHistoryTotals(
  driverId: string,
  q: { from?: string | null; to?: string | null }
): Promise<{ delivered: number; failed: number; cancelled: number; reassigned: number }> {
  const { data, error } = await createAdminClient().rpc("ops_rider_history_totals", {
    p_rider: driverId,
    p_from: q.from ?? null,
    p_to: q.to ?? null,
  });
  if (error) throw error;
  const t = (data ?? {}) as Record<string, number>;
  return { delivered: t.delivered ?? 0, failed: t.failed ?? 0, cancelled: t.cancelled ?? 0, reassigned: t.reassigned ?? 0 };
}

/** The most rows the performance windows read: a rider's six months of jobs. */
const WINDOW_ROWS = 5000;

/** Jobs, offer events and shifts since `from` — the inputs to figures.ts. */
export async function performanceInputs(
  driverId: string,
  from: Date
): Promise<{ deliveries: FigureDelivery[]; events: FigureEvent[]; shifts: { startedAt: string; endedAt: string | null }[] }> {
  const supabase = createAdminClient();
  const [rows, ev, sh] = await Promise.all([
    historyRows(driverId, { from: istDay(from) }, WINDOW_ROWS),
    supabase
      .from("delivery_events")
      .select("kind, created_at")
      .eq("driver_id", driverId)
      .in("kind", ["offered", "accepted"])
      .gte("created_at", from.toISOString())
      .order("created_at", { ascending: false })
      .limit(WINDOW_ROWS),
    supabase
      .from("rider_shifts")
      .select("started_at, ended_at")
      .eq("driver_id", driverId)
      .or(`ended_at.is.null,ended_at.gte.${from.toISOString()}`)
      .order("started_at", { ascending: false })
      .limit(WINDOW_ROWS),
  ]);
  if (ev.error && !isMissingTable(ev.error)) throw ev.error;
  if (sh.error && !isMissingTable(sh.error)) throw sh.error;
  return {
    deliveries: rows.map((r) => ({
      outcome: r.outcome,
      acceptedAt: r.accepted_at,
      pickedUpAt: r.picked_up_at,
      deliveredAt: r.delivered_at,
      endedAt: new Date(r.ended_at).toISOString(),
    })),
    events: ((ev.data ?? []) as { kind: string; created_at: string }[]).map((e) => ({ kind: e.kind, at: e.created_at })),
    shifts: ((sh.data ?? []) as { started_at: string; ended_at: string | null }[]).map((s) => ({ startedAt: s.started_at, endedAt: s.ended_at })),
  };
}

export interface RiderPerformance {
  daily: { target: number; done: number };
  weekly: { target: number; done: number };
  avgAcceptToDeliverMin: number | null;
  avgPickupToDeliverMin: number | null;
  acceptanceRate: number | null;
  failedRate: number | null;
  onlineHoursThisWeek: number;
  rating: { average: number | null; count: number; recent: { rating: number; comment: string | null; at: string }[] };
  months: { month: string; delivered: number; failed: number; cancelled: number; acceptanceRate: number | null; avgDeliverMin: number | null; earnings: number | null; onlineHours: number }[];
}

const IST_OFFSET_MS = 330 * 60_000;

/** Monday 00:00 IST of the week containing `now`. */
function istWeekStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = (ist.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - day);
  return new Date(start - IST_OFFSET_MS);
}

function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

/** Daily / weekly targets: the settings when > 0 (Rider 0084), else the largest active rule, else 0 (hidden). */
async function targets(): Promise<{ daily: number; weekly: number }> {
  const supabase = createAdminClient();
  let daily = 0;
  let weekly = 0;
  const s = await supabase.from("platform_settings").select("rider_daily_target, rider_weekly_target").maybeSingle();
  if (!s.error && s.data) {
    daily = Number((s.data as { rider_daily_target?: number }).rider_daily_target ?? 0);
    weekly = Number((s.data as { rider_weekly_target?: number }).rider_weekly_target ?? 0);
  } else if (s.error && !isMissingColumn(s.error)) {
    throw s.error;
  }
  if (daily > 0 && weekly > 0) return { daily, weekly };
  const rules = await supabase.from("rider_incentive_rules").select("period, target_deliveries").eq("active", true);
  if (rules.error && !isMissingTable(rules.error)) throw rules.error;
  for (const r of (rules.data ?? []) as { period: string; target_deliveries: number }[]) {
    if (r.period === "daily" && daily <= 0) daily = Math.max(daily, r.target_deliveries);
    if (r.period === "weekly" && weekly <= 0) weekly = Math.max(weekly, r.target_deliveries);
  }
  return { daily, weekly };
}

/** The Rider app's Performance screen: the last six months and this week. */
export async function getRiderPerformance(driverId: string, now: Date = new Date()): Promise<RiderPerformance> {
  const sixMonths = new Date(now.getTime() - 183 * 86_400_000);
  const supabase = createAdminClient();
  const [inputs, goal, ratings, facts] = await Promise.all([
    performanceInputs(driverId, sixMonths),
    targets(),
    supabase
      .from("rider_ratings")
      .select("rating, comment, created_at")
      .eq("driver_id", driverId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase.rpc("ops_rider_list_facts", { p_ids: [driverId], p_day_start: istDayStart(now).toISOString() }),
  ]);
  if (facts.error) throw facts.error;
  const fact = ((facts.data ?? []) as { rating_avg: number | string | null; rating_count: number }[])[0];
  if (ratings.error && !isMissingTable(ratings.error)) throw ratings.error;
  const rows = (ratings.data ?? []) as { rating: number; comment: string | null; created_at: string }[];
  const dayStart = istDayStart(now);
  const weekStart = istWeekStart(now);
  const done = (since: Date) => inputs.deliveries.filter((d) => d.outcome === "delivered" && Date.parse(d.endedAt) >= since.getTime()).length;
  const all = performanceOf(inputs.deliveries, inputs.events, inputs.shifts, sixMonths, now);
  const week = performanceOf([], [], inputs.shifts, weekStart, now);
  return {
    daily: { target: goal.daily, done: done(dayStart) },
    weekly: { target: goal.weekly, done: done(weekStart) },
    avgAcceptToDeliverMin: all.avgDeliverMinutes,
    avgPickupToDeliverMin: all.avgPickupToDeliverMinutes,
    acceptanceRate: all.acceptanceRate,
    failedRate: all.failedRate,
    onlineHoursThisWeek: week.onlineHours,
    rating: {
      average: fact?.rating_avg === null || fact?.rating_avg === undefined ? null : Math.round(Number(fact.rating_avg) * 10) / 10,
      count: fact?.rating_count ?? 0,
      recent: rows.map((r) => ({ rating: r.rating, comment: r.comment, at: r.created_at })),
    },
    months: monthsOf(inputs.deliveries, inputs.events, inputs.shifts, now).map((m) => ({ ...m, earnings: null })),
  };
}
