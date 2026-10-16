import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readAllRows } from "@/lib/data-access/read-all";
import {
  columnKnownMissing,
  columnKnownPresent,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { shortOrderId } from "@/lib/utils/order-map";
import {
  addIstDays,
  startOfIstDay,
  startOfIstMonth,
  startOfIstWeek,
} from "@/lib/utils/ist-time";

export type EarningsRange =
  | "today"
  | "week"
  | "month"
  | "last_month"
  | "last_30";

interface EarningsSeriesPoint {
  key: string;
  label: string;
  revenue: number;
  orders: number;
}

interface EarningsTopDish {
  name: string;
  qty: number;
  revenue: number;
}

interface EarningsRecentOrder {
  id: string;
  code: string;
  total: number;
  status: string;
  createdAt: string;
  placedLabel: string;
}

export interface VendorEarningsSummary {
  range: EarningsRange;
  rangeLabel: string;
  /** Selected period */
  periodRevenue: number;
  periodOrders: number;
  periodAvgOrder: number;
  periodChangePercent: number | null;
  prevPeriodRevenue: number;
  prevPeriodOrders: number;
  /** Fee mix in period (revenue statuses) */
  itemsSubtotal: number;
  deliveryFees: number;
  taxAmount: number;
  cancelledCount: number;
  cancelledValue: number;
  pendingCount: number;
  pendingValue: number;
  deliveredRevenue: number;
  deliveredOrders: number;
  /** Lifetime */
  lifetimeTotal: number;
  lifetimeOrders: number;
  lifetimeAvgOrderValue: number;
  todayRevenue: number;
  todayOrders: number;
  series: EarningsSeriesPoint[];
  topDishes: EarningsTopDish[];
  hourly: { hour: number; label: string; orders: number; revenue: number }[];
  recentOrders: EarningsRecentOrder[];
  refundsPending: number;
  refundsPendingCount: number;
  refundsApproved: number;
  refundsApprovedCount: number;
  bestBucketLabel: string;
  bestBucketRevenue: number;
}

const REVENUE_STATUSES = [
  "kitchen",
  "ready",
  "on_the_way",
  "delivered",
] as const;

const PENDING_STATUSES = ["placed", "kitchen", "ready", "on_the_way"] as const;

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface OrderRow {
  id: string;
  total: number;
  delivery_fee: number | null;
  tax_amount: number | null;
  status: string;
  created_at: string;
  /** 0031. Rupees the customer didn't pay. Absent before that migration. */
  discount?: number | null;
  /** 0041. Who absorbed it — `"vendor"` or `"platform"`. */
  discount_funded_by?: string | null;
}

/**
 * `orders.discount_funded_by` arrives with 0041, `orders.discount` with 0031.
 *
 * Probed once per process rather than guessed: asking PostgREST for a column
 * that doesn't exist is a hard 400, so a database mid-rollout would lose the
 * whole earnings screen rather than one line of it. Without the columns the
 * figures are what they were before 0031 — customer-paid totals — which is the
 * honest reading of a database that has no coupons.
 */
const COUPON_COLUMNS = "orders.discount_funded_by";

async function couponColumnsAvailable(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<boolean> {
  if (columnKnownPresent(COUPON_COLUMNS)) return true;
  if (columnKnownMissing(COUPON_COLUMNS)) return false;

  const { error } = await supabase
    .from("orders")
    .select("discount, discount_funded_by")
    .limit(1);
  const present = !isMissingColumn(error);
  rememberColumn(COUPON_COLUMNS, present);
  return present;
}

/**
 * What one order was worth to this shop.
 *
 * `orders.total` is what the *customer* paid, and since 0031 that is net of any
 * coupon. Reading it as the shop's revenue is how the vendor came to fund every
 * platform promotion silently: a ₹100 code run by Deligro took ₹100 off this
 * number and nothing anywhere said the shop should be made whole.
 *
 * So the discount is added back, and then taken off again only when the shop
 * ran the promotion itself. A shop-funded code is a real cost to the shop and
 * belongs in these figures; a platform-funded one is not.
 *
 * On a database before 0031 both fields are absent, `discount` reads 0, and
 * this is `total` — exactly what it was.
 */
function shopValue(row: OrderRow): number {
  const discount = Number(row.discount ?? 0) || 0;
  const vendorFunded = row.discount_funded_by === "vendor" ? discount : 0;
  return (Number(row.total) || 0) + discount - vendorFunded;
}

/**
 * An instant moved to IST, to be read with the getUTC* accessors. `getHours()` /
 * `getDay()` read the HOST's zone, which is UTC on Vercel, so the hourly and
 * weekday charts put every order 5½ hours early: a 9pm dinner order landed in
 * the 3pm bucket and late-night orders on the wrong weekday.
 */
function istShifted(iso: string): Date {
  return new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000);
}

function startOfDay(d: Date): Date {
  return startOfIstDay(d);
}

function startOfWeek(d: Date): Date {
  return startOfIstWeek(d);
}

function startOfMonth(d: Date): Date {
  return startOfIstMonth(d);
}

function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? 100 : null;
  return Math.round(((current - previous) / previous) * 100);
}

function isRevenue(status: string): boolean {
  return (REVENUE_STATUSES as readonly string[]).includes(status);
}

export function resolveEarningsWindow(
  range: EarningsRange,
  now = new Date()
): {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  label: string;
} {
  const today = startOfDay(now);
  const end = new Date(now);
  end.setMilliseconds(end.getMilliseconds() + 1);

  if (range === "today") {
    const start = today;
    const prevStart = addIstDays(today, -1);
    return {
      start,
      end,
      prevStart,
      prevEnd: start,
      label: "Today",
    };
  }

  if (range === "week") {
    const start = startOfWeek(now);
    const weekEnd = addIstDays(start, 7);
    const prevStart = addIstDays(start, -7);
    return {
      start,
      end: weekEnd > end ? end : weekEnd,
      prevStart,
      prevEnd: start,
      label: "This week",
    };
  }

  if (range === "month") {
    const start = startOfMonth(now);
    const prevStart = startOfMonth(addIstDays(start, -1));
    return {
      start,
      end,
      prevStart,
      prevEnd: start,
      label: "This month",
    };
  }

  if (range === "last_month") {
    const monthEnd = startOfMonth(now);
    const start = startOfMonth(addIstDays(monthEnd, -1));
    const prevStart = startOfMonth(addIstDays(start, -1));
    return {
      start,
      end: monthEnd,
      prevStart,
      prevEnd: start,
      label: "Last month",
    };
  }

  // last_30
  const start = addIstDays(today, -29);
  const prevStart = addIstDays(start, -30);
  return {
    start,
    end,
    prevStart,
    prevEnd: start,
    label: "Last 30 days",
  };
}

function formatPlaced(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function sumRevenue(rows: OrderRow[]): {
  revenue: number;
  orders: number;
  items: number;
  delivery: number;
  tax: number;
} {
  let revenue = 0;
  let orders = 0;
  let items = 0;
  let delivery = 0;
  let tax = 0;
  for (const row of rows) {
    if (!isRevenue(row.status)) continue;
    const value = shopValue(row);
    const fee = Number(row.delivery_fee) || 0;
    const taxAmt = Number(row.tax_amount) || 0;
    revenue += value;
    orders += 1;
    delivery += fee;
    tax += taxAmt;
    items += Math.max(0, value - fee - taxAmt);
  }
  return { revenue, orders, items, delivery, tax };
}

function buildDailySeries(
  rows: OrderRow[],
  start: Date,
  end: Date
): EarningsSeriesPoint[] {
  const points: EarningsSeriesPoint[] = [];
  const cursor = startOfDay(start);
  const endDay = startOfDay(new Date(end.getTime() - 1));

  while (cursor <= endDay) {
    const key = cursor.toISOString().slice(0, 10);
    // `cursor` is IST midnight, which is 18:30 UTC the day before: formatted in
    // the host's zone the label named the previous day.
    const label = cursor.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      timeZone: "Asia/Kolkata",
    });
    points.push({ key, label, revenue: 0, orders: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const index = new Map(points.map((p, i) => [p.key, i]));
  for (const row of rows) {
    if (!isRevenue(row.status)) continue;
    const key = startOfDay(new Date(row.created_at)).toISOString().slice(0, 10);
    const i = index.get(key);
    if (i === undefined) continue;
    points[i].revenue += shopValue(row);
    points[i].orders += 1;
  }
  return points;
}

function buildHourlySeries(rows: OrderRow[]): VendorEarningsSummary["hourly"] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${hour.toString().padStart(2, "0")}:00`,
    orders: 0,
    revenue: 0,
  }));
  for (const row of rows) {
    if (!isRevenue(row.status)) continue;
    const h = istShifted(row.created_at).getUTCHours();
    hours[h].orders += 1;
    hours[h].revenue += shopValue(row);
  }
  return hours;
}

function buildWeekdaySeries(rows: OrderRow[]): EarningsSeriesPoint[] {
  const buckets = [1, 2, 3, 4, 5, 6, 0].map((dayIdx) => ({
    key: DAY_LABELS[dayIdx],
    label: DAY_LABELS[dayIdx],
    revenue: 0,
    orders: 0,
  }));
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  for (const row of rows) {
    if (!isRevenue(row.status)) continue;
    const label = DAY_LABELS[istShifted(row.created_at).getUTCDay()];
    const i = index.get(label);
    if (i === undefined) continue;
    buckets[i].revenue += shopValue(row);
    buckets[i].orders += 1;
  }
  return buckets;
}

/** Full earnings dashboard for a restaurant + range. */
export async function getVendorEarningsSummary(
  restaurantId: string,
  range: EarningsRange = "week"
): Promise<VendorEarningsSummary> {
  const supabase = await createClient();
  const now = new Date();
  const window = resolveEarningsWindow(range, now);
  const todayStart = startOfDay(now);

  const fetchFrom = window.prevStart.toISOString();
  const fetchTo = window.end.toISOString();

  // Every query below asks for the coupon columns or none of them, so the whole
  // screen reads one way or the other rather than mixing net and gross figures.
  const coupons = await couponColumnsAvailable(supabase);
  const money = coupons ? "total, discount, discount_funded_by" : "total";

  const [
    ordersResult,
    pendingResult,
    lifetimeResult,
    todayResult,
    itemsResult,
    refundsResult,
  ] = await Promise.all([
    // Paged (read-all.ts): a month for a busy shop passes PostgREST's 1000-row
    // cap, and a short read here is a wrong revenue figure, not a slow screen.
    readAllRows((from, to) =>
      supabase
        .from("orders")
        .select(`id, ${money}, delivery_fee, tax_amount, status, created_at`)
        .eq("restaurant_id", restaurantId)
        .gte("created_at", fetchFrom)
        .lt("created_at", fetchTo)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
    supabase
      .from("orders")
      .select(money)
      .eq("restaurant_id", restaurantId)
      .in("status", [...PENDING_STATUSES]),
    readAllRows((from, to) =>
      supabase
        .from("orders")
        .select(money)
        .eq("restaurant_id", restaurantId)
        .eq("status", "delivered")
        .order("id")
        .range(from, to)
    ),
    supabase
      .from("orders")
      .select(money)
      .eq("restaurant_id", restaurantId)
      .in("status", [...REVENUE_STATUSES])
      .gte("created_at", todayStart.toISOString()),
    readAllRows((from, to) =>
      supabase
        .from("order_items")
        .select("name, qty, price, orders!inner(restaurant_id, status, created_at)")
        .eq("orders.restaurant_id", restaurantId)
        .in("orders.status", [...REVENUE_STATUSES])
        .gte("orders.created_at", window.start.toISOString())
        .lt("orders.created_at", window.end.toISOString())
        .order("id")
        .range(from, to)
    ),
    readAllRows((from, to) =>
      supabase
        .from("refunds")
        .select("amount, status, orders!inner(restaurant_id, created_at)")
        .eq("orders.restaurant_id", restaurantId)
        .gte("orders.created_at", window.start.toISOString())
        .lt("orders.created_at", window.end.toISOString())
        .order("id")
        .range(from, to)
    ),
  ]);

  if (ordersResult.error) throw ordersResult.error;

  // The column list is assembled at runtime (see `money`), so PostgREST's
  // type parser can't narrow it — the shape is asserted here instead.
  const allRows = (ordersResult.data ?? []) as unknown as OrderRow[];
  const periodRows = allRows.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return t >= window.start.getTime() && t < window.end.getTime();
  });
  const prevRows = allRows.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return t >= window.prevStart.getTime() && t < window.prevEnd.getTime();
  });

  const period = sumRevenue(periodRows);
  const prev = sumRevenue(prevRows);

  let cancelledCount = 0;
  let cancelledValue = 0;
  let deliveredRevenue = 0;
  let deliveredOrders = 0;
  for (const row of periodRows) {
    if (row.status === "cancelled") {
      cancelledCount += 1;
      cancelledValue += shopValue(row);
    }
    if (row.status === "delivered") {
      deliveredOrders += 1;
      deliveredRevenue += shopValue(row);
    }
  }

  const pendingRows = (pendingResult.data ?? []) as unknown as OrderRow[];
  let pendingCount = 0;
  let pendingValue = 0;
  for (const r of pendingRows) {
    pendingCount += 1;
    pendingValue += shopValue(r);
  }

  const lifetimeRows = (lifetimeResult.data ?? []) as unknown as OrderRow[];
  let lifetimeTotal = 0;
  let lifetimeOrders = 0;
  for (const r of lifetimeRows) {
    lifetimeOrders += 1;
    lifetimeTotal += shopValue(r);
  }

  const todayRows = (todayResult.data ?? []) as unknown as OrderRow[];
  let todayRevenue = 0;
  let todayOrders = 0;
  for (const r of todayRows) {
    todayOrders += 1;
    todayRevenue += shopValue(r);
  }

  const series =
    range === "today"
      ? buildHourlySeries(periodRows).map((h) => ({
          key: h.label,
          label: h.label,
          revenue: h.revenue,
          orders: h.orders,
        }))
      : range === "week"
        ? buildWeekdaySeries(periodRows)
        : buildDailySeries(periodRows, window.start, window.end);

  const hourly = buildHourlySeries(periodRows);

  const dishMap = new Map<string, EarningsTopDish>();
  if (!itemsResult.error) {
    for (const row of itemsResult.data ?? []) {
      const name = (row.name as string)?.trim() || "Item";
      const qty = Number(row.qty) || 0;
      const price = Number(row.price) || 0;
      const existing = dishMap.get(name) ?? { name, qty: 0, revenue: 0 };
      existing.qty += qty;
      existing.revenue += qty * price;
      dishMap.set(name, existing);
    }
  }
  const topDishes = [...dishMap.values()]
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .slice(0, 8);

  let refundsPending = 0;
  let refundsPendingCount = 0;
  let refundsApproved = 0;
  let refundsApprovedCount = 0;
  // Refunds RLS is customer/admin-only today — fail soft for vendors.
  if (!refundsResult.error) {
    for (const row of refundsResult.data ?? []) {
      const amount = Number(row.amount) || 0;
      if (row.status === "pending") {
        refundsPending += amount;
        refundsPendingCount += 1;
      } else if (row.status === "approved") {
        refundsApproved += amount;
        refundsApprovedCount += 1;
      }
    }
  }

  const recentOrders: EarningsRecentOrder[] = periodRows
    .filter((r) => isRevenue(r.status))
    .sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0))
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      code: `#${shortOrderId(r.id)}`,
      total: Number(r.total) || 0,
      status: r.status,
      createdAt: r.created_at,
      placedLabel: formatPlaced(r.created_at),
    }));

  const best = series.reduce(
    (top, p) => (p.revenue > top.revenue ? p : top),
    series[0] ?? { key: "—", label: "—", revenue: 0, orders: 0 }
  );

  return {
    range,
    rangeLabel: window.label,
    periodRevenue: period.revenue,
    periodOrders: period.orders,
    periodAvgOrder:
      period.orders > 0 ? Math.round(period.revenue / period.orders) : 0,
    periodChangePercent: changePercent(period.revenue, prev.revenue),
    prevPeriodRevenue: prev.revenue,
    prevPeriodOrders: prev.orders,
    itemsSubtotal: period.items,
    deliveryFees: period.delivery,
    taxAmount: period.tax,
    cancelledCount,
    cancelledValue,
    pendingCount,
    pendingValue,
    deliveredRevenue,
    deliveredOrders,
    lifetimeTotal,
    lifetimeOrders,
    lifetimeAvgOrderValue:
      lifetimeOrders > 0 ? Math.round(lifetimeTotal / lifetimeOrders) : 0,
    todayRevenue,
    todayOrders,
    series,
    topDishes,
    hourly,
    recentOrders,
    refundsPending,
    refundsPendingCount,
    refundsApproved,
    refundsApprovedCount,
    bestBucketLabel: best.label,
    bestBucketRevenue: best.revenue,
  };
}

export function isEarningsRange(value: string): value is EarningsRange {
  return (
    value === "today" ||
    value === "week" ||
    value === "month" ||
    value === "last_month" ||
    value === "last_30"
  );
}
