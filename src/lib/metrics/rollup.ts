/**
 * The dashboard and statistics rebuilt from SQL rollups (migration 0144).
 *
 * `ops_dashboard_rollup` and `ops_stats_rollup` sum the rows where they live,
 * so a city's all-time figures are one query rather than every order pulled
 * into Node. These functions turn those sums into exactly the objects
 * `computeDashboard` and `computeStats` return — same fields, same rounding,
 * same ordering — so a screen cannot tell which path produced its numbers.
 * scripts/qa/ops-sql-parity.ts runs both paths over the same fixtures and
 * requires identical output; `definitions.ts` stays the reference.
 */
import { growth, type SalesSummary } from "./definitions";
import type { Dashboard, DashboardFigures } from "./dashboard";
import { bucketKey, daysInRange } from "./ist";
import {
  UNCATEGORISED,
  type CategoryRank,
  type CompletedVsCancelled,
  type PeakHours,
  type SeriesPoint,
  type Stats,
  type VendorRank,
  type ZoneRow,
} from "./stats";
import type { CancelledBy, DateRange, Granularity } from "./types";

/** Dashboard figures the platform cannot count yet (a sibling table is missing). */
export type DashboardUnavailable =
  | "onlineRiders"
  | "riderPaymentsDue"
  | "pendingMarketingRequests"
  | "pendingSupportTickets";

/** `ops_dashboard_rollup`'s answer. A null count = its table does not exist yet. */
export interface DashboardRollup {
  todaysOrders: number;
  todaysTotalSales: number;
  totalOrders: number;
  totalSales: number;
  pendingOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  totalDeliveryFees: number;
  totalPlatformCommission: number;
  vendorPaymentsDue: number;
  vendorRecoverable: number;
  activeVendors: number;
  onlineVendors: number;
  activeRiders: number;
  onlineRiders: number | null;
  ridersOnDelivery: number;
  pendingMarketingRequests: number | null;
  pendingSupportTickets: number | null;
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * The eighteen figures from the rollup. Rider pay comes from the Rider app's
 * ledger (Phase 5); until then it is unavailable, as it was before.
 */
export function dashboardFromRollup(
  r: DashboardRollup,
  today: string
): { dashboard: Dashboard; unavailable: DashboardUnavailable[]; vendorRecoverable: number } {
  const unavailable: DashboardUnavailable[] = [];
  const optional = (v: number | null | undefined, key: DashboardUnavailable): number => {
    if (v === null || v === undefined) {
      unavailable.push(key);
      return 0;
    }
    return n(v);
  };
  const onlineRiders = optional(r.onlineRiders, "onlineRiders");
  unavailable.push("riderPaymentsDue");
  const pendingMarketingRequests = optional(r.pendingMarketingRequests, "pendingMarketingRequests");
  const pendingSupportTickets = optional(r.pendingSupportTickets, "pendingSupportTickets");

  const figures: DashboardFigures = {
    todaysTotalSales: n(r.todaysTotalSales),
    totalSales: n(r.totalSales),
    todaysOrders: n(r.todaysOrders),
    totalOrders: n(r.totalOrders),
    pendingOrders: n(r.pendingOrders),
    completedOrders: n(r.completedOrders),
    cancelledOrders: n(r.cancelledOrders),
    activeVendors: n(r.activeVendors),
    onlineVendors: n(r.onlineVendors),
    activeRiders: n(r.activeRiders),
    onlineRiders,
    ridersOnDelivery: n(r.ridersOnDelivery),
    totalDeliveryFees: n(r.totalDeliveryFees),
    totalPlatformCommission: n(r.totalPlatformCommission),
    vendorPaymentsDue: n(r.vendorPaymentsDue),
    riderPaymentsDue: 0,
    pendingMarketingRequests,
    pendingSupportTickets,
  };
  return { dashboard: { today, figures }, unavailable, vendorRecoverable: n(r.vendorRecoverable) };
}

/** `ops_stats_rollup`'s totals for one period. */
export interface StatsSummaryRollup {
  salesOrders: number;
  grossSales: number;
  customerPaid: number;
  discountVendor: number;
  discountPlatform: number;
  refundsTotal: number;
  refundsCount: number;
  refundsOnCancelled: number;
  cancelledCount: number;
  cancelledValue: number;
  completedCount: number;
  completedValue: number;
  deliveryFees: number;
}

/** `ops_stats_rollup`'s answer. The groupings are absent for a summary-only call. */
export interface StatsRollup {
  summary: StatsSummaryRollup;
  byDay?: { date: string; orders: number; sales: number; cancelled: number }[];
  byCancelledBy?: Partial<Record<CancelledBy | "unknown", { count: number; value: number }>>;
  reasons?: { reason: string; count: number }[];
  peak?: { weekday: number; hour: number; orders: number }[];
  byVendor?: { restaurantId: string; orders: number; sales: number; cancelled: number; refunds: number }[];
  byCategory?: { category: string; sales: number; qty: number; orders: number }[];
  byZone?: { zoneId: string | null; orders: number; sales: number; cancelled: number }[];
}

const aov = (paid: number, orders: number) => (orders === 0 ? 0 : Math.round(paid / orders));

/** `salesSummary` from the rollup's totals. */
export function summaryFromRollup(s: StatsSummaryRollup): SalesSummary {
  const vendor = n(s.discountVendor);
  const platform = n(s.discountPlatform);
  const total = vendor + platform;
  const refundsTotal = n(s.refundsTotal);
  const gross = n(s.grossSales);
  return {
    orders: n(s.salesOrders),
    grossSales: gross,
    customerPaid: n(s.customerPaid),
    discounts: { vendor, platform, total },
    refunds: { total: refundsTotal, count: n(s.refundsCount), onCancelled: n(s.refundsOnCancelled) },
    netSales: gross - total - refundsTotal,
    cancelled: { count: n(s.cancelledCount), value: n(s.cancelledValue) },
    deliveryFees: n(s.deliveryFees),
    averageOrderValue: aov(n(s.customerPaid), n(s.salesOrders)),
  };
}

/** The days of `range`, zero-filled, from the rollup's day rows (`dailySeries`). */
export function dailyFromRollup(r: StatsRollup, range: DateRange): SeriesPoint[] {
  const byDay = new Map((r.byDay ?? []).map((d) => [d.date, d]));
  return daysInRange(range).map((date) => {
    const d = byDay.get(date);
    return { date, orders: n(d?.orders), sales: n(d?.sales), cancelled: n(d?.cancelled) };
  });
}

/** `bucketSeries` from the rollup's day rows. */
export function bucketsFromRollup(r: StatsRollup, range: DateRange, granularity: Granularity): SeriesPoint[] {
  const daily = dailyFromRollup(r, range);
  if (granularity === "day") return daily;
  const buckets = new Map<string, SeriesPoint>();
  for (const d of daily) {
    const key = bucketKey(`${d.date}T12:00:00+05:30`, granularity);
    const b = buckets.get(key) ?? { date: key, orders: 0, sales: 0, cancelled: 0 };
    b.orders += d.orders;
    b.sales += d.sales;
    b.cancelled += d.cancelled;
    buckets.set(key, b);
  }
  return [...buckets.values()];
}

function completedVsCancelledFromRollup(r: StatsRollup): CompletedVsCancelled {
  const s = r.summary;
  const all = n(s.salesOrders) + n(s.cancelledCount);
  const by = r.byCancelledBy ?? {};
  const cv = (k: CancelledBy | "unknown") => ({ count: n(by[k]?.count), value: n(by[k]?.value) });
  return {
    completed: { count: n(s.completedCount), value: n(s.completedValue) },
    cancelled: { count: n(s.cancelledCount), value: n(s.cancelledValue) },
    completionRate: all === 0 ? 0 : n(s.completedCount) / all,
    cancellationRate: all === 0 ? 0 : n(s.cancelledCount) / all,
    byCancelledBy: {
      customer: cv("customer"),
      vendor: cv("vendor"),
      manager: cv("manager"),
      admin: cv("admin"),
      system: cv("system"),
      unknown: cv("unknown"),
    },
    topReasons: (r.reasons ?? [])
      .map((x) => ({ reason: x.reason, count: n(x.count) }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

function peakFromRollup(r: StatsRollup): PeakHours {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byHour = new Array<number>(24).fill(0);
  for (const p of r.peak ?? []) {
    if (p.weekday < 0 || p.weekday > 6 || p.hour < 0 || p.hour > 23) continue;
    grid[p.weekday][p.hour] += n(p.orders);
    byHour[p.hour] += n(p.orders);
  }
  const topHours = byHour
    .map((orders, hour) => ({ hour, orders }))
    .filter((h) => h.orders > 0)
    .sort((a, b) => b.orders - a.orders || a.hour - b.hour)
    .slice(0, 5);
  return { grid, topHours };
}

/**
 * Everything `computeStats` returns for `range`, plus the day-by-day series
 * and the previous period's AOV the statistics payload adds.
 */
export function statsFromRollup(
  current: StatsRollup,
  previous: StatsRollup,
  range: DateRange,
  opts: {
    granularity?: Granularity;
    names?: Map<string, string>;
    ratings?: Map<string, number>;
    limit?: number;
  } = {}
): { stats: Stats; daily: SeriesPoint[]; previousAverageOrderValue: number } {
  const summary = summaryFromRollup(current.summary);
  const prev = summaryFromRollup(previous.summary);

  const vendors: VendorRank[] = (current.byVendor ?? []).map((v) => ({
    restaurantId: v.restaurantId,
    name: opts.names?.get(v.restaurantId) ?? "Shop",
    orders: n(v.orders),
    sales: n(v.sales),
    averageOrderValue: aov(n(v.sales), n(v.orders)),
    cancelled: n(v.cancelled),
    refunds: n(v.refunds),
    rating: opts.ratings?.get(v.restaurantId) ?? null,
  }));
  vendors.sort(
    (a, b) =>
      b.sales - a.sales ||
      b.orders - a.orders ||
      a.name.localeCompare(b.name) ||
      a.restaurantId.localeCompare(b.restaurantId)
  );

  const categories: CategoryRank[] = (current.byCategory ?? []).map((c) => ({
    category: c.category?.trim() || UNCATEGORISED,
    sales: n(c.sales),
    qty: n(c.qty),
    orders: n(c.orders),
  }));
  categories.sort((a, b) => b.sales - a.sales || b.qty - a.qty || a.category.localeCompare(b.category));

  const zones: ZoneRow[] = (current.byZone ?? []).map((z) => ({
    zoneId: z.zoneId ?? null,
    orders: n(z.orders),
    sales: n(z.sales),
    cancelled: n(z.cancelled),
    averageOrderValue: aov(n(z.sales), n(z.orders)),
  }));
  zones.sort(
    (a, b) => b.sales - a.sales || b.orders - a.orders || (a.zoneId ?? "").localeCompare(b.zoneId ?? "")
  );

  const stats: Stats = {
    range,
    summary,
    series: bucketsFromRollup(current, range, opts.granularity ?? "day"),
    growth: {
      sales: growth(summary.customerPaid, prev.customerPaid),
      orders: growth(summary.orders, prev.orders),
    },
    completedVsCancelled: completedVsCancelledFromRollup(current),
    peakHours: peakFromRollup(current),
    bestVendors: opts.limit ? vendors.slice(0, opts.limit) : vendors,
    bestCategories: opts.limit ? categories.slice(0, opts.limit) : categories,
    zones,
  };
  return { stats, daily: dailyFromRollup(current, range), previousAverageOrderValue: prev.averageOrderValue };
}
