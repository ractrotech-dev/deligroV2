import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import {
  effectiveCommissionPct,
  getCommissionGstPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { addDays, istDayKey, istDayStart, rangeBounds } from "@/lib/metrics/ist";
import type { Dashboard } from "@/lib/metrics/dashboard";
import {
  dashboardFromRollup,
  type DashboardRollup,
  type DashboardUnavailable,
  type StatsRollup,
} from "@/lib/metrics/rollup";
import type { DateRange, MetricOrder, MetricRefund, PricingContext } from "@/lib/metrics/types";
import { cached, scopeCacheKey } from "@/lib/server-cache";
import {
  METRIC_DISCOUNT_COLUMNS,
  METRIC_ORDER_COLUMNS,
  toMetricOrder,
  type ItemRow,
  type OrderRow,
} from "@/lib/data-access/ops-metrics-map";

/**
 * The rows the ops metrics are computed from, read with the service role and
 * limited to a `ManagerScope` (migration 0141's zones).
 *
 * **Caller authorises first.** Every function here bypasses RLS; it is only as
 * safe as the `managerApiContext()` / `requireRole("admin")` above it (AGENTS.md
 * rule 5). Every read of a zoned table filters by the scope — orders by
 * `zone_id`, deliveries and settlement lines through their order, shops by
 * their `zone_id`, riders through `staff_zones` — via the plain id list
 * (`scopeZoneIds`), because these builders are too deep for the generic
 * `applyZoneScope` to type.
 */

/** null = not probed yet; latches after the first query (as admin-reports). */
let hasDiscountColumns: boolean | null = null;

/**
 * Orders in the scope, optionally inside an IST date range, optionally with
 * their item lines (and each dish's category). Cancelled orders are included:
 * the metrics module separates them, so every figure sees the same rows.
 */
export async function loadMetricOrders(
  scope: ManagerScope,
  opts: { range?: DateRange; withItems?: boolean; restaurantId?: string } = {}
): Promise<MetricOrder[]> {
  const supabase = createAdminClient();
  const zoneIds = scopeZoneIds(scope);
  const bounds = opts.range ? rangeBounds(opts.range) : null;

  const run = (cols: string) =>
    readAllRows<OrderRow>((from, to) => {
      let q = supabase.from("orders").select(cols);
      if (zoneIds) q = q.in("zone_id", zoneIds);
      if (opts.restaurantId) q = q.eq("restaurant_id", opts.restaurantId);
      if (bounds) {
        q = q.gte("created_at", bounds.start.toISOString()).lt("created_at", bounds.endExclusive.toISOString());
      }
      return q
        .order("created_at", { ascending: true })
        .order("id")
        .range(from, to)
        .overrideTypes<OrderRow[]>();
    });

  const withDiscount = `${METRIC_ORDER_COLUMNS}, ${METRIC_DISCOUNT_COLUMNS}`;
  let result = await run(hasDiscountColumns === false ? METRIC_ORDER_COLUMNS : withDiscount);
  if (result.error && hasDiscountColumns !== false && isMissingColumn(result.error as { code?: string })) {
    hasDiscountColumns = false;
    result = await run(METRIC_ORDER_COLUMNS);
  } else if (!result.error) {
    hasDiscountColumns = hasDiscountColumns ?? true;
  }
  if (result.error) throw result.error;
  const rows = result.data;

  if (!opts.withItems || rows.length === 0) return rows.map((r) => toMetricOrder(r));

  // Paged inside each chunk: 100 orders can carry more than PostgREST's
  // 1000-row page of lines, and a short read would understate every category.
  const { data: itemRows, error } = await readInChunks<ItemRow>(
    rows.map((r) => r.id),
    async (chunk) => {
      const page = await readAllRows<ItemRow>((from, to) =>
        supabase
          .from("order_items")
          .select("id, order_id, name, qty, price, menu_item_id, menu_items(category)")
          .in("order_id", chunk)
          .order("id")
          .range(from, to)
          .overrideTypes<ItemRow[]>()
      );
      return { data: page.data, error: page.error };
    }
  );
  if (error) throw error;
  const byOrder = new Map<string, ItemRow[]>();
  for (const it of itemRows ?? []) {
    const list = byOrder.get(it.order_id);
    if (list) list.push(it);
    else byOrder.set(it.order_id, [it]);
  }
  return rows.map((r) => toMetricOrder(r, byOrder.get(r.id) ?? []));
}

/** Approved refunds on these orders. A failed read throws — never "no refunds". */
export async function loadRefunds(orderIds: string[]): Promise<MetricRefund[]> {
  if (orderIds.length === 0) return [];
  const supabase = createAdminClient();
  const { data, error } = await readInChunks<{ id: string; order_id: string; amount: number | string }>(
    orderIds,
    (chunk) =>
      supabase
        .from("refunds")
        .select("id, order_id, amount")
        .in("order_id", chunk)
        .eq("status", "approved")
        .overrideTypes<{ id: string; order_id: string; amount: number | string }[]>()
  );
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    orderId: r.order_id,
    amount: Number(r.amount) || 0,
    status: "approved" as const,
  }));
}

/**
 * The settlement terms for these shops: effective commission (shop override,
 * else platform default), per-order charges, and commission GST — the same
 * sources admin-reports and the settlement ledger read.
 */
export async function loadPricing(restaurantIds: string[]): Promise<PricingContext> {
  const supabase = createAdminClient();
  const ids = [...new Set(restaurantIds)];
  const [platformDefault, commissionGstPct] = await Promise.all([
    getVendorCommissionDefault(),
    getCommissionGstPct(),
  ]);
  const commissionPct = new Map<string, number>();
  const otherCharges = new Map<string, number>();
  if (ids.length > 0) {
    type ShopTerms = { id: string; commission_pct: number | string | null; other_charges_per_order?: number | string | null };
    const read = (withCharges: boolean) =>
      readInChunks<ShopTerms>(ids, (chunk) =>
        supabase
          // By id, not by zone: these are the shops of orders already read
          // in scope, and a shop that has since moved zone still prices its
          // old orders.
          .from("restaurants")
          .select(`id, commission_pct${withCharges ? ", other_charges_per_order" : ""}`)
          .in("id", chunk)
          .overrideTypes<ShopTerms[]>()
      );
    let res = await read(true);
    if (res.error && isMissingColumn(res.error as { code?: string })) res = await read(false);
    if (res.error) throw res.error;
    for (const r of res.data ?? []) {
      const pct = r.commission_pct === null || r.commission_pct === undefined ? null : Number(r.commission_pct);
      commissionPct.set(r.id, effectiveCommissionPct(pct, platformDefault));
      otherCharges.set(r.id, Math.max(0, Math.round(Number(r.other_charges_per_order ?? 0))));
    }
  }
  return { commissionPct, otherCharges, commissionGstPct };
}

/**
 * Names and ratings of these shops, for the statistics' rankings. By id: the
 * ids come from orders already read in scope.
 */
export async function loadShopNames(
  restaurantIds: string[]
): Promise<{ names: Map<string, string>; ratings: Map<string, number> }> {
  const names = new Map<string, string>();
  const ratings = new Map<string, number>();
  const ids = [...new Set(restaurantIds)];
  if (ids.length === 0) return { names, ratings };
  type Shop = { id: string; name: string | null; rating: number | string | null };
  const { data, error } = await readInChunks<Shop>(ids, (chunk) =>
    createAdminClient()
      .from("restaurants")
      .select("id, name, rating")
      .in("id", chunk)
      .overrideTypes<Shop[]>()
  );
  if (error) throw error;
  for (const r of data ?? []) {
    names.set(r.id, r.name?.trim() || "Shop");
    const rating = r.rating === null ? Number.NaN : Number(r.rating);
    if (Number.isFinite(rating) && rating > 0) ratings.set(r.id, Math.round(rating * 10) / 10);
  }
  return { names, ratings };
}

/** Dashboard figures the platform cannot count yet. */
export type UnavailableKey = DashboardUnavailable;

/** How long a dashboard or statistics answer is shared between callers. */
const ROLLUP_TTL_MS = 20_000;

/**
 * The eighteen figures for a scope, summed in Postgres by
 * `ops_dashboard_rollup` (migration 0144) rather than read row by row. Shared
 * for 20 s between callers with the same zones. A failed read throws — the
 * route answers 500, never zeros.
 */
export async function loadDashboard(
  scope: ManagerScope,
  now: Date
): Promise<{ dashboard: Dashboard; unavailable: UnavailableKey[] }> {
  const zoneIds = scopeZoneIds(scope);
  const today = istDayKey(now);
  return cached(`dashboard:${scopeCacheKey(zoneIds)}:${today}`, ROLLUP_TTL_MS, async () => {
    const [platformDefault, commissionGstPct] = await Promise.all([
      getVendorCommissionDefault(),
      getCommissionGstPct(),
    ]);
    const { data, error } = await createAdminClient().rpc("ops_dashboard_rollup", {
      p_zone_ids: zoneIds === null ? null : [...zoneIds],
      p_today_start: istDayStart(today).toISOString(),
      p_today_end: istDayStart(addDays(today, 1)).toISOString(),
      p_now: now.toISOString(),
      p_commission_default: platformDefault,
      p_gst_pct: commissionGstPct,
    });
    if (error) throw error;
    if (!data) throw new Error("ops_dashboard_rollup returned nothing");
    const { dashboard, unavailable } = dashboardFromRollup(data as DashboardRollup, today);
    return { dashboard, unavailable };
  });
}

/**
 * One period's statistics sums from `ops_stats_rollup` (migration 0144). The
 * previous period only needs its totals (`summaryOnly`).
 */
async function statsRollup(
  zoneIds: readonly string[] | null,
  range: DateRange,
  summaryOnly: boolean,
  restaurantId: string | null = null
): Promise<StatsRollup> {
  const bounds = rangeBounds(range);
  const { data, error } = await createAdminClient().rpc("ops_stats_rollup", {
    p_zone_ids: zoneIds === null ? null : [...zoneIds],
    p_start: bounds.start.toISOString(),
    p_end: bounds.endExclusive.toISOString(),
    p_restaurant: restaurantId,
    p_summary_only: summaryOnly,
  });
  if (error) throw error;
  if (!data) throw new Error("ops_stats_rollup returned nothing");
  return data as StatsRollup;
}

/** The current and previous period's statistics sums, shared for 20 s per scope and range. */
export async function loadStatsRollups(
  scope: ManagerScope,
  range: DateRange,
  previous: DateRange,
  restaurantId: string | null = null
): Promise<{ current: StatsRollup; previous: StatsRollup }> {
  const zoneIds = scopeZoneIds(scope);
  const key = `stats:${scopeCacheKey(zoneIds)}:${restaurantId ?? "all"}:${range.from}:${range.to}:${previous.from}:${previous.to}`;
  return cached(key, ROLLUP_TTL_MS, async () => {
    const [cur, prev] = await Promise.all([
      statsRollup(zoneIds, range, false, restaurantId),
      statsRollup(zoneIds, previous, true, restaurantId),
    ]);
    return { current: cur, previous: prev };
  });
}
