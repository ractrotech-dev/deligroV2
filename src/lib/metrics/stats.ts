/**
 * Business statistics (spec §2): the series, comparisons and rankings behind
 * the statistics screens and their reports. Built from `definitions.ts` so a
 * chart's total is the dashboard's total for the same rows.
 */
import {
  countedOrders,
  customerPaid,
  growth,
  isCancelled,
  isCompleted,
  orderRates,
  salesOrders,
  salesSummary,
  type SalesSummary,
} from "./definitions";
import { bucketKey, daysInRange, inRange, istDayKey, istHourWeekday } from "./ist";
import type {
  CancelledBy,
  DateRange,
  Granularity,
  Growth,
  MetricOrder,
  MetricRefund,
} from "./types";

const rupees = (n: number) => Math.round(Number(n) || 0);

export interface SeriesPoint {
  /** Day key for daily points; the bucket key ("YYYY-MM-DD" Monday, "YYYY-MM", "YYYY") otherwise. */
  date: string;
  /** Non-cancelled orders. */
  orders: number;
  /** Customer paid on non-cancelled orders. */
  sales: number;
  cancelled: number;
}

/** One point per IST day of the range, zero-filled. Orders outside it are dropped. */
export function dailySeries(orders: MetricOrder[], range: DateRange): SeriesPoint[] {
  const buckets = new Map<string, SeriesPoint>();
  for (const day of daysInRange(range)) {
    buckets.set(day, { date: day, orders: 0, sales: 0, cancelled: 0 });
  }
  for (const o of countedOrders(orders)) {
    const point = buckets.get(istDayKey(o.createdAt));
    if (!point) continue;
    if (isCancelled(o)) point.cancelled += 1;
    else {
      point.orders += 1;
      point.sales += rupees(o.total);
    }
  }
  return [...buckets.values()];
}

/** The range grouped by week, month or year — every bucket the range touches, zero-filled. */
export function bucketSeries(
  orders: MetricOrder[],
  range: DateRange,
  granularity: Granularity
): SeriesPoint[] {
  if (granularity === "day") return dailySeries(orders, range);
  const buckets = new Map<string, SeriesPoint>();
  for (const day of daysInRange(range)) {
    const key = bucketKey(`${day}T12:00:00+05:30`, granularity);
    if (!buckets.has(key)) buckets.set(key, { date: key, orders: 0, sales: 0, cancelled: 0 });
  }
  for (const o of countedOrders(orders)) {
    if (!inRange(o.createdAt, range)) continue;
    const point = buckets.get(bucketKey(o.createdAt, granularity));
    if (!point) continue;
    if (isCancelled(o)) point.cancelled += 1;
    else {
      point.orders += 1;
      point.sales += rupees(o.total);
    }
  }
  return [...buckets.values()];
}

/** Sales and order growth against the previous period's rows. */
export function periodGrowth(
  current: MetricOrder[],
  previous: MetricOrder[]
): { sales: Growth; orders: Growth } {
  return {
    sales: growth(customerPaid(current), customerPaid(previous)),
    orders: growth(salesOrders(current).length, salesOrders(previous).length),
  };
}

type CountValue = { count: number; value: number };

export interface CompletedVsCancelled {
  completed: CountValue;
  cancelled: CountValue;
  completionRate: number;
  cancellationRate: number;
  /** Cancellations by who cancelled; "unknown" for orders before 0051. */
  byCancelledBy: Record<CancelledBy | "unknown", CountValue>;
  /** Cancellation reasons, most frequent first. */
  topReasons: { reason: string; count: number }[];
}

export function completedVsCancelled(orders: MetricOrder[]): CompletedVsCancelled {
  const zero = (): CountValue => ({ count: 0, value: 0 });
  const result: CompletedVsCancelled = {
    completed: zero(),
    cancelled: zero(),
    ...orderRates(orders),
    byCancelledBy: {
      customer: zero(),
      vendor: zero(),
      manager: zero(),
      admin: zero(),
      system: zero(),
      unknown: zero(),
    },
    topReasons: [],
  };
  const reasons = new Map<string, number>();
  for (const o of countedOrders(orders)) {
    const value = rupees(o.total);
    if (isCompleted(o)) {
      result.completed.count += 1;
      result.completed.value += value;
    } else if (isCancelled(o)) {
      result.cancelled.count += 1;
      result.cancelled.value += value;
      const by = result.byCancelledBy[o.cancelledBy ?? "unknown"] ?? result.byCancelledBy.unknown;
      by.count += 1;
      by.value += value;
      const reason = o.cancellationReason?.trim();
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  result.topReasons = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return result;
}

export interface PeakHours {
  /** `grid[weekday][hour]` = non-cancelled orders; Monday = 0, hours in IST. */
  grid: number[][];
  /** The busiest hours of day across the week, busiest first (top 5). */
  topHours: { hour: number; orders: number }[];
}

export function peakHours(orders: MetricOrder[]): PeakHours {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byHour = new Array<number>(24).fill(0);
  for (const o of salesOrders(orders)) {
    const { hour, weekday } = istHourWeekday(o.createdAt);
    grid[weekday][hour] += 1;
    byHour[hour] += 1;
  }
  const topHours = byHour
    .map((n, hour) => ({ hour, orders: n }))
    .filter((h) => h.orders > 0)
    .sort((a, b) => b.orders - a.orders || a.hour - b.hour)
    .slice(0, 5);
  return { grid, topHours };
}

export interface VendorRank {
  restaurantId: string;
  name: string;
  orders: number;
  sales: number;
  averageOrderValue: number;
  cancelled: number;
  refunds: number;
  /** Average rating when the caller supplies it. */
  rating: number | null;
}

/** Shops ranked by sales (customer paid), then by orders. */
export function bestVendors(
  orders: MetricOrder[],
  refunds: MetricRefund[],
  opts: { names?: Map<string, string>; ratings?: Map<string, number>; limit?: number } = {}
): VendorRank[] {
  const byShop = new Map<string, MetricOrder[]>();
  for (const o of countedOrders(orders)) {
    const list = byShop.get(o.restaurantId) ?? [];
    list.push(o);
    byShop.set(o.restaurantId, list);
  }
  const ranks: VendorRank[] = [...byShop.entries()].map(([restaurantId, list]) => {
    const s = salesSummary(list, refunds);
    return {
      restaurantId,
      name: opts.names?.get(restaurantId) ?? "Shop",
      orders: s.orders,
      sales: s.customerPaid,
      averageOrderValue: s.averageOrderValue,
      cancelled: s.cancelled.count,
      refunds: s.refunds.total,
      rating: opts.ratings?.get(restaurantId) ?? null,
    };
  });
  ranks.sort((a, b) => b.sales - a.sales || b.orders - a.orders || a.name.localeCompare(b.name));
  return opts.limit ? ranks.slice(0, opts.limit) : ranks;
}

export interface CategoryRank {
  category: string;
  /** qty × unit price over the category's lines. */
  sales: number;
  qty: number;
  /** Distinct orders with at least one line in the category. */
  orders: number;
}

export const UNCATEGORISED = "Uncategorised";

/** Categories ranked by item sales. Only orders whose lines were loaded contribute. */
export function bestCategories(orders: MetricOrder[], limit?: number): CategoryRank[] {
  const byCat = new Map<string, CategoryRank & { orderIds: Set<string> }>();
  for (const o of salesOrders(orders)) {
    for (const line of o.items ?? []) {
      const category = line.category?.trim() || UNCATEGORISED;
      const rank = byCat.get(category) ?? { category, sales: 0, qty: 0, orders: 0, orderIds: new Set() };
      rank.sales += rupees(line.qty) * rupees(line.price);
      rank.qty += rupees(line.qty);
      rank.orderIds.add(o.id);
      byCat.set(category, rank);
    }
  }
  const ranks = [...byCat.values()].map(({ orderIds, ...r }) => ({ ...r, orders: orderIds.size }));
  ranks.sort((a, b) => b.sales - a.sales || b.qty - a.qty || a.category.localeCompare(b.category));
  return limit ? ranks.slice(0, limit) : ranks;
}

export interface ZoneRow {
  /** Null for orders placed before zones existed. */
  zoneId: string | null;
  orders: number;
  sales: number;
  cancelled: number;
  averageOrderValue: number;
}

/** Orders, sales, cancellations and AOV per delivery zone, busiest first. */
export function zoneBreakdown(orders: MetricOrder[]): ZoneRow[] {
  const byZone = new Map<string | null, MetricOrder[]>();
  for (const o of countedOrders(orders)) {
    const key = o.zoneId ?? null;
    const list = byZone.get(key) ?? [];
    list.push(o);
    byZone.set(key, list);
  }
  return [...byZone.entries()]
    .map(([zoneId, list]) => {
      const live = salesOrders(list);
      const sales = customerPaid(list);
      return {
        zoneId,
        orders: live.length,
        sales,
        cancelled: list.length - live.length,
        averageOrderValue: live.length === 0 ? 0 : Math.round(sales / live.length),
      };
    })
    .sort((a, b) => b.sales - a.sales || b.orders - a.orders);
}

export interface Stats {
  range: DateRange;
  summary: SalesSummary;
  series: SeriesPoint[];
  growth: { sales: Growth; orders: Growth };
  completedVsCancelled: CompletedVsCancelled;
  peakHours: PeakHours;
  bestVendors: VendorRank[];
  bestCategories: CategoryRank[];
  zones: ZoneRow[];
}

/**
 * Everything the statistics screen shows for one range. `orders` and
 * `previousOrders` are filtered to `range` and to the previous period's range
 * respectively by the caller's query; rows outside `range` are dropped here
 * too so a loose query cannot leak into the figures.
 */
export function computeStats(
  orders: MetricOrder[],
  previousOrders: MetricOrder[],
  refunds: MetricRefund[],
  range: DateRange,
  opts: {
    granularity?: Granularity;
    names?: Map<string, string>;
    ratings?: Map<string, number>;
    limit?: number;
  } = {}
): Stats {
  const inWindow = countedOrders(orders).filter((o) => inRange(o.createdAt, range));
  const granularity = opts.granularity ?? "day";
  return {
    range,
    summary: salesSummary(inWindow, refunds),
    series: bucketSeries(inWindow, range, granularity),
    growth: periodGrowth(inWindow, previousOrders),
    completedVsCancelled: completedVsCancelled(inWindow),
    peakHours: peakHours(inWindow),
    bestVendors: bestVendors(inWindow, refunds, { names: opts.names, ratings: opts.ratings, limit: opts.limit }),
    bestCategories: bestCategories(inWindow, opts.limit),
    zones: zoneBreakdown(inWindow),
  };
}
