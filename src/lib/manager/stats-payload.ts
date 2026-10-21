/**
 * The statistics screen's answer (§2): every item of the section from one
 * load of orders, through the shared metrics. Pure; the route loads the rows
 * and the names.
 */
import { averageOrderValue, growth } from "@/lib/metrics/definitions";
import { inRange, rangeLength } from "@/lib/metrics/ist";
import {
  computeStats,
  dailySeries,
  type Stats,
  type CategoryRank,
  type CompletedVsCancelled,
  type PeakHours,
  type SeriesPoint,
  type VendorRank,
} from "@/lib/metrics/stats";
import type { SalesSummary } from "@/lib/metrics/definitions";
import type { DateRange, Granularity, Growth, MetricOrder, MetricRefund } from "@/lib/metrics/types";
import { statsFromRollup, type StatsRollup } from "@/lib/metrics/rollup";
import type { StatsGranularity, StatsQuery } from "./stats-query";

/** A custom range longer than this is drawn by month rather than by day. */
const DAILY_BARS_MAX = 62;

/** Cities and their zones, as `listCitiesWithZones` returns them (only the names are used). */
export interface ZoneNames {
  id: string;
  name: string;
  zones: { id: string; name: string }[];
}

/**
 * The sales summary as a manager sees it. Delivery fees, discounts, refunds and
 * net sales are finance figures: present only with `manager.finance.view`,
 * absent from the JSON (not zeroed) without it — the dashboard's rule.
 */
export type StatsSummary = Omit<SalesSummary, "deliveryFees" | "discounts" | "refunds" | "netSales"> &
  Partial<Pick<SalesSummary, "deliveryFees" | "discounts" | "refunds" | "netSales">>;

/** A vendor ranking row; `refunds` only with `manager.finance.view`. */
export type StatsVendorRank = Omit<VendorRank, "refunds"> & { refunds?: number };

export interface StatsPayload {
  generatedAt: string;
  granularity: StatsGranularity;
  range: DateRange;
  previous: DateRange;
  zone: string | null;
  summary: StatsSummary;
  /** One point per IST day of the range — §2.1, day-by-day sales. */
  daily: SeriesPoint[];
  /** The chart's bars: by day, or by month for a year or a long custom range. */
  bucketGranularity: Granularity;
  buckets: SeriesPoint[];
  growth: { sales: Growth; orders: Growth };
  averageOrderValue: { current: number; previous: number; growth: Growth };
  completedVsCancelled: CompletedVsCancelled;
  peakHours: PeakHours;
  bestVendors: StatsVendorRank[];
  bestCategories: CategoryRank[];
  /** The zones rolled up per city, busiest first (§2.11 "city-wise"). */
  byCity: {
    cityName: string;
    orders: number;
    sales: number;
    cancelled: number;
    averageOrderValue: number;
  }[];
  byZone: {
    zoneId: string | null;
    zoneName: string;
    cityName: string | null;
    orders: number;
    sales: number;
    cancelled: number;
    averageOrderValue: number;
  }[];
}

function bucketGranularityFor(q: StatsQuery): Granularity {
  if (q.granularity === "year") return "month";
  if (q.granularity === "custom" && rangeLength(q.range) > DAILY_BARS_MAX) return "month";
  return "day";
}

export interface StatsPayloadOptions {
  now: Date;
  /** `manager.finance.view`: without it the finance figures are left out. */
  canSeeFinance: boolean;
  vendorNames: Map<string, string>;
  vendorRatings: Map<string, number>;
  zones: ZoneNames[];
}

/** What the payload is assembled from, whichever path computed it. */
interface StatsParts {
  stats: Stats;
  daily: SeriesPoint[];
  previousAverageOrderValue: number;
}

/**
 * The payload from order rows — the reference path, computed by
 * `src/lib/metrics` in Node. Tests and small datasets use it.
 */
export function statsPayload(
  orders: MetricOrder[],
  refunds: MetricRefund[],
  q: StatsQuery,
  opts: StatsPayloadOptions
): StatsPayload {
  const current = orders.filter((o) => inRange(o.createdAt, q.range));
  const previous = orders.filter((o) => inRange(o.createdAt, q.previous));
  const stats = computeStats(current, previous, refunds, q.range, {
    granularity: bucketGranularityFor(q),
    names: opts.vendorNames,
    ratings: opts.vendorRatings,
    limit: 10,
  });
  return assemble(
    { stats, daily: dailySeries(current, q.range), previousAverageOrderValue: averageOrderValue(previous) },
    q,
    opts
  );
}

/**
 * The payload from `ops_stats_rollup` sums (migration 0144) — what the route
 * serves. Same object as `statsPayload` for the same rows; parity is proven by
 * scripts/qa/ops-sql-parity.ts.
 */
export function statsPayloadFromRollups(
  current: StatsRollup,
  previous: StatsRollup,
  q: StatsQuery,
  opts: StatsPayloadOptions
): StatsPayload {
  const parts = statsFromRollup(current, previous, q.range, {
    granularity: bucketGranularityFor(q),
    names: opts.vendorNames,
    ratings: opts.vendorRatings,
    limit: 10,
  });
  return assemble(parts, q, opts);
}

function assemble(parts: StatsParts, q: StatsQuery, opts: StatsPayloadOptions): StatsPayload {
  const { stats } = parts;
  const zoneInfo = new Map<string, { zone: string; city: string }>();
  for (const c of opts.zones) for (const z of c.zones) zoneInfo.set(z.id, { zone: z.name, city: c.name });

  const aovNow = stats.summary.averageOrderValue;
  const aovBefore = parts.previousAverageOrderValue;

  return {
    generatedAt: opts.now.toISOString(),
    granularity: q.granularity,
    range: q.range,
    previous: q.previous,
    zone: q.zone,
    summary: opts.canSeeFinance ? stats.summary : withoutFinance(stats.summary),
    daily: parts.daily,
    bucketGranularity: bucketGranularityFor(q),
    buckets: stats.series,
    growth: stats.growth,
    averageOrderValue: { current: aovNow, previous: aovBefore, growth: growth(aovNow, aovBefore) },
    completedVsCancelled: stats.completedVsCancelled,
    peakHours: stats.peakHours,
    bestVendors: opts.canSeeFinance ? stats.bestVendors : stats.bestVendors.map(vendorWithoutRefunds),
    bestCategories: stats.bestCategories,
    byCity: citySubtotals(stats.zones, zoneInfo),
    byZone: stats.zones.map((z) => {
      const info = z.zoneId ? zoneInfo.get(z.zoneId) : undefined;
      return {
        zoneId: z.zoneId,
        zoneName: info?.zone ?? (z.zoneId ? "Zone" : "No zone"),
        cityName: info?.city ?? null,
        orders: z.orders,
        sales: z.sales,
        cancelled: z.cancelled,
        averageOrderValue: z.averageOrderValue,
      };
    }),
  };
}

function withoutFinance(s: SalesSummary): StatsSummary {
  return {
    orders: s.orders,
    grossSales: s.grossSales,
    customerPaid: s.customerPaid,
    cancelled: s.cancelled,
    averageOrderValue: s.averageOrderValue,
  };
}

function vendorWithoutRefunds(v: VendorRank): StatsVendorRank {
  const copy: StatsVendorRank = { ...v };
  delete copy.refunds;
  return copy;
}

/** Zone rows summed per city; a zone with no known city counts as "No city". */
function citySubtotals(
  zones: Stats["zones"],
  zoneInfo: Map<string, { zone: string; city: string }>
): StatsPayload["byCity"] {
  const byCity = new Map<string, { orders: number; sales: number; cancelled: number }>();
  for (const z of zones) {
    const city = (z.zoneId ? zoneInfo.get(z.zoneId)?.city : undefined) ?? "No city";
    const row = byCity.get(city) ?? { orders: 0, sales: 0, cancelled: 0 };
    row.orders += z.orders;
    row.sales += z.sales;
    row.cancelled += z.cancelled;
    byCity.set(city, row);
  }
  return [...byCity.entries()]
    .map(([cityName, r]) => ({
      cityName,
      ...r,
      averageOrderValue: r.orders === 0 ? 0 : Math.round(r.sales / r.orders),
    }))
    .sort((a, b) => b.sales - a.sales || b.orders - a.orders || a.cityName.localeCompare(b.cityName));
}
