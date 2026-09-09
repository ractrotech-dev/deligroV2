import type { DailyPoint } from "@/lib/data-access/admin-series";

/**
 * One place the console's charts agree with each other and with the page
 * around them.
 *
 * Every colour is a CSS custom property rather than a hex literal, so a chart
 * follows the palette switch instead of staying dark-console orange on a light
 * page. Recharts takes `stroke` and `fill` as plain strings and hands them
 * straight to SVG, so `var(--accent)` resolves exactly as it would in CSS.
 */
export const CHART = {
  accent: "var(--accent)",
  green: "var(--green)",
  blue: "var(--blue)",
  amber: "var(--pop)",
  red: "var(--deal)",
  grid: "var(--c-divider)",
  axis: "var(--muted)",
  bar: "var(--c-bar)",
  barPeak: "var(--c-bar-peak)",
} as const;

/** Axis and grid settings every time-series chart in the console shares. */
export const AXIS = {
  fontSize: 10.5,
  tickLine: false,
  axisLine: false,
  stroke: CHART.axis,
} as const;

/* ============================================================
   Metrics
   ============================================================ */

/**
 * What a trend chart can plot.
 *
 * Platform earnings is deliberately absent. It has no per-day series — working
 * it out for a single day needs a per-vendor commission-rate recompute that
 * `getAdminSeries` does not do — so offering it as a toggle would mean either
 * a blank chart or a number derived from the other two, which is arithmetic
 * dressed up as a measurement. It gets a KPI and a period-over-period delta
 * instead, both of which are real.
 */
export type TrendMetric = "revenue" | "orders" | "aov";

export interface MetricSpec {
  key: TrendMetric;
  label: string;
  /** Reads the value off a day. AOV is derived, which is why this is a function. */
  valueOf: (d: DailyPoint) => number;
  format: (n: number) => string;
  /** Compact form, for axis ticks where there is no room for "₹1,24,500". */
  tick: (n: number) => string;
  color: string;
}

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const num = (n: number) => Math.round(n).toLocaleString("en-IN");

/**
 * Indian-notation compact figures for axis ticks. `Intl`'s `notation: compact`
 * gives "1.2L" / "12L" for en-IN, which is the right vocabulary — an operator
 * here reads lakhs, not "120K".
 */
const compact = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const TREND_METRICS: Record<TrendMetric, MetricSpec> = {
  revenue: {
    key: "revenue",
    label: "Revenue",
    valueOf: (d) => d.gmv,
    format: inr,
    tick: (n) => (n ? "₹" + compact.format(n) : "0"),
    color: CHART.accent,
  },
  orders: {
    key: "orders",
    label: "Orders",
    valueOf: (d) => d.orders,
    format: num,
    tick: (n) => (n ? compact.format(n) : "0"),
    color: CHART.blue,
  },
  aov: {
    key: "aov",
    label: "Avg order value",
    // A day with no orders has no average, not an average of zero. Zero is the
    // only thing a chart can draw, but the tooltip says "no orders" rather
    // than "₹0" so the flat stretch is not read as a collapse in basket size.
    valueOf: (d) => (d.orders > 0 ? Math.round(d.gmv / d.orders) : 0),
    format: inr,
    tick: (n) => (n ? "₹" + compact.format(n) : "0"),
    color: CHART.green,
  },
};

export const TREND_METRIC_ORDER: TrendMetric[] = ["revenue", "orders", "aov"];

export function isTrendMetric(v: string | undefined): v is TrendMetric {
  return v === "revenue" || v === "orders" || v === "aov";
}

/** Every nth tick, so a 30-day axis does not turn into a smear of dates. */
export function tickGap(count: number): number {
  if (count <= 8) return 0;
  return Math.max(1, Math.ceil(count / 8) - 1);
}
