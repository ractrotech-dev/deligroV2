import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import {
  effectiveCommissionPct,
  getCommissionGstPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { rangeBounds } from "@/lib/metrics/ist";
import type { DashboardCounts } from "@/lib/metrics/dashboard";
import type { DateRange, MetricOrder, MetricRefund, PricingContext } from "@/lib/metrics/types";
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

  const { data: itemRows, error } = await readInChunks<ItemRow>(
    rows.map((r) => r.id),
    (chunk) =>
      supabase
        .from("order_items")
        .select("order_id, name, qty, price, menu_item_id, menu_items(category)")
        .in("order_id", chunk)
        .overrideTypes<ItemRow[]>()
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
    const rating = r.rating === null ? NaN : Number(r.rating);
    if (Number.isFinite(rating) && rating > 0) ratings.set(r.id, Math.round(rating * 10) / 10);
  }
  return { names, ratings };
}

/** Orders in the scope whose vendor share sits in a paid settlement. */
export async function loadPaidOrderIds(scope: ManagerScope): Promise<Set<string>> {
  const supabase = createAdminClient();
  const zoneIds = scopeZoneIds(scope);
  type Line = { order_id: string };
  const result = await readAllRows<Line>((from, to) => {
    let q = supabase
      .from("vendor_settlement_orders")
      .select("order_id, vendor_settlements!inner(status), orders!inner(zone_id)")
      .eq("vendor_settlements.status", "paid");
    if (zoneIds) q = q.in("orders.zone_id", zoneIds);
    return q.order("order_id").range(from, to).overrideTypes<Line[]>();
  });
  if (result.error) {
    // Before 0028 there are no settlements, so nothing has been paid.
    if (isMissingTable(result.error as { code?: string })) return new Set();
    throw result.error;
  }
  return new Set(result.data.map((r) => r.order_id));
}

/** Dashboard figures that come from status tables rather than orders. */
export type UnavailableKey =
  | "onlineRiders"
  | "riderPaymentsDue"
  | "pendingMarketingRequests"
  | "pendingSupportTickets";

/** Drivers who share one of the scope's zones; null = every driver (admin). */
async function scopedStaffIds(scope: ManagerScope): Promise<Set<string> | null> {
  const zoneIds = scopeZoneIds(scope);
  if (!zoneIds) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("staff_zones")
    .select("user_id, profiles!inner(role)")
    .in("zone_id", zoneIds)
    .eq("profiles.role", "driver")
    .overrideTypes<{ user_id: string }[]>();
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.user_id));
}

async function countDrivers(): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "driver");
  if (error) throw error;
  return count ?? 0;
}

/**
 * Vendor, rider, marketing and support counts for the dashboard. A count whose
 * table does not exist yet (a sibling branch's migration) is reported in
 * `unavailable` and reads 0 in `counts`; any other failure throws.
 */
export async function loadDashboardCounts(
  scope: ManagerScope,
  now: Date
): Promise<{ counts: DashboardCounts; unavailable: UnavailableKey[] }> {
  const supabase = createAdminClient();
  const zoneIds = scopeZoneIds(scope);
  const unavailable: UnavailableKey[] = [];

  // Shops.
  let shopQuery = supabase.from("restaurants").select("id, status, is_open");
  if (zoneIds) shopQuery = shopQuery.in("zone_id", zoneIds);
  const shops = await shopQuery.overrideTypes<{ id: string; status: string | null; is_open: boolean | null }[]>();
  if (shops.error) throw shops.error;
  const active = (shops.data ?? []).filter((s) => s.status === "active");
  const shopIds = (shops.data ?? []).map((s) => s.id);

  // Riders: who is in scope, who is online, who is carrying an order.
  const staff = await scopedStaffIds(scope);
  const activeRiders = staff ? staff.size : await countDrivers();

  let onlineRiders = 0;
  {
    const { data, error } = await supabase
      .from("rider_status")
      .select("driver_id, is_online, break_until")
      .eq("is_online", true)
      .overrideTypes<{ driver_id: string; is_online: boolean; break_until: string | null }[]>();
    if (error) {
      if (!isMissingTable(error)) throw error;
      unavailable.push("onlineRiders");
    } else {
      onlineRiders = (data ?? []).filter(
        (r) =>
          (!staff || staff.has(r.driver_id)) &&
          (!r.break_until || new Date(r.break_until).getTime() <= now.getTime())
      ).length;
    }
  }

  let legs = supabase
    .from("deliveries")
    .select("driver_id, orders!inner(zone_id)")
    .in("status", ["assigned", "picked_up"])
    .not("driver_id", "is", null);
  if (zoneIds) legs = legs.in("orders.zone_id", zoneIds);
  const onDelivery = await legs.overrideTypes<{ driver_id: string }[]>();
  if (onDelivery.error) throw onDelivery.error;
  const ridersOnDelivery = new Set((onDelivery.data ?? []).map((d) => d.driver_id)).size;

  // Rider pay is the Rider app's ledger; it is computed from there in Phase 5.
  unavailable.push("riderPaymentsDue");

  // Marketing requests (Partner app) and support tickets (shared): counted
  // the day their tables exist, without an app release.
  let pendingMarketingRequests = 0;
  {
    let q = supabase.from("marketing_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    if (zoneIds) q = q.in("restaurant_id", shopIds.length > 0 ? shopIds : ["00000000-0000-0000-0000-000000000000"]);
    const { count, error } = await q;
    if (error) {
      if (!isMissingTable(error) && !isMissingColumn(error)) throw error;
      unavailable.push("pendingMarketingRequests");
    } else pendingMarketingRequests = count ?? 0;
  }

  let pendingSupportTickets = 0;
  {
    let q = supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "in_progress", "escalated"]);
    if (zoneIds) q = q.in("zone_id", zoneIds);
    const { count, error } = await q;
    if (error) {
      if (!isMissingTable(error) && !isMissingColumn(error)) throw error;
      unavailable.push("pendingSupportTickets");
    } else pendingSupportTickets = count ?? 0;
  }

  return {
    counts: {
      activeVendors: active.length,
      onlineVendors: active.filter((s) => s.is_open === true).length,
      activeRiders,
      onlineRiders,
      ridersOnDelivery,
      riderPaymentsDue: 0,
      pendingMarketingRequests,
      pendingSupportTickets,
    },
    unavailable,
  };
}
