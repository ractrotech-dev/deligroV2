/**
 * Sales statistics and growth for the Partner app (client requirements §2).
 * Pure: the data access loads orders and lines, this shapes them. Tested by
 * scripts/qa/vendor-analytics.ts.
 *
 * Every date is an IST calendar date. India has no daylight saving, so IST is
 * a fixed +05:30 and bucketing is plain arithmetic on that offset.
 */
export type Granularity = "day" | "week" | "month" | "year" | "custom";

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_MS).toISOString().slice(0, 10);
}

/** IST midnight of a YYYY-MM-DD, as an instant. */
export function istMidnight(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Monday of the IST week containing `day`. */
function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export type BucketUnit = "day" | "week" | "month" | "year";

export interface AnalyticsWindow {
  granularity: Granularity;
  unit: BucketUnit;
  /** Inclusive first IST day. */
  from: string;
  /** Inclusive last IST day. */
  to: string;
  /** The equal-length period immediately before. */
  prevFrom: string;
  prevTo: string;
}

export const MAX_CUSTOM_DAYS = 366;

/**
 * The window a request asks for. Day = the last 7 days by day; week = the last
 * 8 weeks by week; month = the last 12 months by month; year = the last 3
 * years by year; custom = from…to (≤ 366 days) by day, or by month beyond 62
 * days. Returns an error code for a malformed custom range.
 */
export function analyticsWindow(
  granularity: string,
  now: Date,
  custom?: { from?: string | null; to?: string | null }
): AnalyticsWindow | { error: "invalid_granularity" | "invalid_range" | "range_too_long" } {
  const today = istDay(now);
  let from: string;
  let to = today;
  let unit: BucketUnit;
  switch (granularity) {
    case "day":
      unit = "day";
      from = addDays(today, -6);
      break;
    case "week":
      unit = "week";
      from = weekStart(addDays(today, -7 * 7));
      break;
    case "month":
      unit = "month";
      from = addMonths(today, -11);
      break;
    case "year": {
      unit = "year";
      from = `${Number(today.slice(0, 4)) - 2}-01-01`;
      break;
    }
    case "custom": {
      const f = custom?.from ?? "";
      const t = custom?.to ?? "";
      const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
      if (!ok(f) || !ok(t) || t < f || t > today) return { error: "invalid_range" };
      if (daysBetween(f, t) + 1 > MAX_CUSTOM_DAYS) return { error: "range_too_long" };
      from = f;
      to = t;
      unit = daysBetween(f, t) + 1 > 62 ? "month" : "day";
      break;
    }
    default:
      return { error: "invalid_granularity" };
  }
  const length = daysBetween(from, to) + 1;
  return { granularity: granularity as Granularity, unit, from, to, prevFrom: addDays(from, -length), prevTo: addDays(from, -1) };
}

function bucketKey(day: string, unit: BucketUnit): string {
  switch (unit) {
    case "day":
      return day;
    case "week":
      return weekStart(day);
    case "month":
      return `${day.slice(0, 7)}-01`;
    case "year":
      return `${day.slice(0, 4)}-01-01`;
  }
}

/** Bucket start days covering from…to, in order. */
export function bucketKeys(w: Pick<AnalyticsWindow, "from" | "to" | "unit">): string[] {
  const keys: string[] = [];
  let k = bucketKey(w.from, w.unit);
  while (k <= w.to) {
    keys.push(k);
    k = w.unit === "day" ? addDays(k, 1) : w.unit === "week" ? addDays(k, 7) : w.unit === "month" ? addMonths(k, 1) : addMonths(k, 12);
  }
  return keys;
}

export interface AnalyticsOrder {
  id: string;
  createdAt: string;
  sale: number;
}

export interface AnalyticsLine {
  orderId: string;
  menuItemId: string | null;
  name: string;
  qty: number;
  price: number;
}

export interface Analytics {
  window: AnalyticsWindow;
  buckets: { start: string; sales: number; orders: number; prevSales: number; prevOrders: number }[];
  totals: {
    sales: number;
    orders: number;
    averageOrderValue: number;
    prevSales: number;
    prevOrders: number;
    prevAverageOrderValue: number;
    /** % change vs the previous period; null when there was nothing to compare with. */
    salesChange: number | null;
    ordersChange: number | null;
    averageOrderValueChange: number | null;
  };
  bestDays: { day: string; sales: number; orders: number }[];
  /** Sales by IST hour 0–23, and the best two-hour window. */
  hours: { hour: number; sales: number; orders: number }[];
  peak: { fromHour: number; toHour: number; sales: number } | null;
  bestSellers: { menuItemId: string | null; name: string; qty: number; revenue: number }[];
  slowMovers: { menuItemId: string; name: string; qty: number; revenue: number }[];
}

function pct(now: number, before: number): number | null {
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export function computeAnalytics(
  window: AnalyticsWindow,
  orders: AnalyticsOrder[],
  lines: AnalyticsLine[],
  menu: { id: string; name: string }[]
): Analytics {
  const from = istMidnight(window.from).getTime();
  const end = istMidnight(addDays(window.to, 1)).getTime();
  const prevFrom = istMidnight(window.prevFrom).getTime();

  const keys = bucketKeys(window);
  const prevKeys = bucketKeys({ from: window.prevFrom, to: window.prevTo, unit: window.unit });
  const cur = new Map(keys.map((k) => [k, { sales: 0, orders: 0 }]));
  const prev = new Map(prevKeys.map((k) => [k, { sales: 0, orders: 0 }]));
  const days = new Map<string, { sales: number; orders: number }>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sales: 0, orders: 0 }));
  const inWindow = new Set<string>();

  for (const o of orders) {
    const t = Date.parse(o.createdAt);
    const day = istDay(new Date(t));
    if (t >= from && t < end) {
      inWindow.add(o.id);
      const b = cur.get(bucketKey(day, window.unit));
      if (b) {
        b.sales += o.sale;
        b.orders++;
      }
      const d = days.get(day) ?? { sales: 0, orders: 0 };
      d.sales += o.sale;
      d.orders++;
      days.set(day, d);
      const h = hours[new Date(t + IST_MS).getUTCHours()];
      h.sales += o.sale;
      h.orders++;
    } else if (t >= prevFrom && t < from) {
      const b = prev.get(bucketKey(day, window.unit));
      if (b) {
        b.sales += o.sale;
        b.orders++;
      }
    }
  }

  const sum = (m: Map<string, { sales: number; orders: number }>) =>
    [...m.values()].reduce((a, b) => ({ sales: a.sales + b.sales, orders: a.orders + b.orders }), { sales: 0, orders: 0 });
  const c = sum(cur);
  const p = sum(prev);
  const aov = c.orders ? Math.round(c.sales / c.orders) : 0;
  const prevAov = p.orders ? Math.round(p.sales / p.orders) : 0;

  let peak: Analytics["peak"] = null;
  for (let hr = 0; hr < 24; hr++) {
    const s = hours[hr].sales + hours[(hr + 1) % 24].sales;
    if (s > 0 && (!peak || s > peak.sales)) peak = { fromHour: hr, toHour: (hr + 2) % 24, sales: s };
  }

  const byItem = new Map<string, { menuItemId: string | null; name: string; qty: number; revenue: number }>();
  for (const l of lines) {
    if (!inWindow.has(l.orderId)) continue;
    const key = l.menuItemId ?? `name:${l.name}`;
    const it = byItem.get(key) ?? { menuItemId: l.menuItemId, name: l.name, qty: 0, revenue: 0 };
    it.qty += l.qty;
    it.revenue += l.qty * l.price;
    byItem.set(key, it);
  }
  const bestSellers = [...byItem.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue).slice(0, 5);
  const slowMovers = menu
    .map((m) => {
      const it = byItem.get(m.id);
      return { menuItemId: m.id, name: m.name, qty: it?.qty ?? 0, revenue: it?.revenue ?? 0 };
    })
    .sort((a, b) => a.qty - b.qty || a.revenue - b.revenue || a.name.localeCompare(b.name))
    .slice(0, 5);

  return {
    window,
    buckets: keys.map((k, i) => {
      const pk = prevKeys[i];
      const pv = pk ? prev.get(pk) : undefined;
      return { start: k, ...cur.get(k)!, prevSales: pv?.sales ?? 0, prevOrders: pv?.orders ?? 0 };
    }),
    totals: {
      sales: c.sales,
      orders: c.orders,
      averageOrderValue: aov,
      prevSales: p.sales,
      prevOrders: p.orders,
      prevAverageOrderValue: prevAov,
      salesChange: pct(c.sales, p.sales),
      ordersChange: pct(c.orders, p.orders),
      averageOrderValueChange: pct(aov, prevAov),
    },
    bestDays: [...days.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 3),
    hours,
    peak,
    bestSellers,
    slowMovers,
  };
}
