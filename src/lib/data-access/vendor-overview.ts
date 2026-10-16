import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readAllRows } from "@/lib/data-access/read-all";
import {
  addIstDays,
  startOfIstDay,
  startOfIstMonth,
  startOfIstWeek,
} from "@/lib/utils/ist-time";

interface OverviewDayPoint {
  day: string;
  orders: number;
  revenue: number;
}

interface OverviewWeekPoint {
  label: string;
  orders: number;
  revenue: number;
}

interface OverviewProduct {
  name: string;
  qty: number;
  revenue: number;
}

interface OverviewCustomer {
  id: string;
  name: string;
  phone: string | null;
  initials: string;
  orders: number;
  spent: number;
}

export interface VendorOverviewSummary {
  todayOrders: number;
  weekOrders: number;
  monthOrders: number;
  lastMonthOrders: number;
  monthChangePercent: number | null;
  weekRevenue: number;
  monthRevenue: number;
  lastMonthRevenue: number;
  avgOrderValue: number;
  daily: OverviewDayPoint[];
  weeklyTrend: OverviewWeekPoint[];
  topProducts: OverviewProduct[];
  totalCustomers: number;
  customersThisMonth: number;
  repeatCustomers: number;
  topCustomers: OverviewCustomer[];
  completedMonth: number;
  cancelledMonth: number;
  pendingNow: number;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const REVENUE_STATUSES = [
  "kitchen",
  "ready",
  "on_the_way",
  "delivered",
] as const;

const PENDING_STATUSES = ["placed", "kitchen", "ready", "on_the_way"] as const;

interface OrderRow {
  id: string;
  customer_id: string;
  total: number;
  status: string;
  created_at: string;
  order_items:
    | { name: string; qty: number; price: number }[]
    | null;
  customer?:
    | { full_name: string | null; phone: string | null }
    | { full_name: string | null; phone: string | null }[]
    | null;
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

function customerInitials(name: string, phone: string | null): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.slice(-2) || "CU";
}

function unwrapCustomer(row: OrderRow) {
  const profile = Array.isArray(row.customer) ? row.customer[0] : row.customer;
  const name = profile?.full_name?.trim() || "Customer";
  const phone = profile?.phone?.trim() || null;
  return { name, phone };
}

/** The windows the summary counts in, each a start instant (IST). */
interface OverviewWindows {
  todayStart: Date;
  weekStart: Date;
  monthStart: Date;
  lastMonthStart: Date;
}

/** Order counts and revenue per window, before they become the summary. */
interface PeriodTally {
  todayOrders: number;
  weekOrders: number;
  monthOrders: number;
  lastMonthOrders: number;
  weekRevenue: number;
  monthRevenue: number;
  lastMonthRevenue: number;
  monthRevenueOrders: number;
  completedMonth: number;
  cancelledMonth: number;
}

interface MonthCustomer {
  name: string;
  phone: string | null;
  orders: number;
  spent: number;
}

interface WeekBucket {
  start: Date;
  end: Date;
  orders: number;
  revenue: number;
}

function emptyTally(): PeriodTally {
  return {
    todayOrders: 0,
    weekOrders: 0,
    monthOrders: 0,
    lastMonthOrders: 0,
    weekRevenue: 0,
    monthRevenue: 0,
    lastMonthRevenue: 0,
    monthRevenueOrders: 0,
    completedMonth: 0,
    cancelledMonth: 0,
  };
}

/** Sunday (0) through Saturday (6), all at zero. */
function emptyWeekdayBuckets(): Map<number, number> {
  const buckets = new Map<number, number>();
  for (let i = 0; i < 7; i++) buckets.set(i, 0);
  return buckets;
}

/** This calendar month's share of one order. */
function tallyMonth(t: PeriodTally, status: string, total: number): void {
  if (status !== "cancelled") t.monthOrders += 1;
  if (isRevenue(status)) {
    t.monthRevenue += total;
    t.monthRevenueOrders += 1;
  }
  if (status === "delivered") t.completedMonth += 1;
  if (status === "cancelled") t.cancelledMonth += 1;
}

/** Count one order into each window it falls in. */
function tallyPeriods(
  t: PeriodTally,
  status: string,
  created: Date,
  total: number,
  w: OverviewWindows
): void {
  const countsAsOrder = status !== "cancelled";
  const inLastMonth = created >= w.lastMonthStart && created < w.monthStart;

  if (created >= w.todayStart && countsAsOrder) t.todayOrders += 1;
  if (created >= w.weekStart && countsAsOrder) {
    t.weekOrders += 1;
    if (isRevenue(status)) t.weekRevenue += total;
  }
  if (created >= w.monthStart) tallyMonth(t, status, total);
  if (inLastMonth) {
    if (countsAsOrder) t.lastMonthOrders += 1;
    if (isRevenue(status)) t.lastMonthRevenue += total;
  }
}

/** One of this week's orders, onto its weekday's bar. */
function addToWeekday(
  orderBuckets: Map<number, number>,
  amountBuckets: Map<number, number>,
  status: string,
  created: Date,
  total: number
): void {
  const idx = created.getDay();
  orderBuckets.set(idx, (orderBuckets.get(idx) ?? 0) + 1);
  if (isRevenue(status)) {
    amountBuckets.set(idx, (amountBuckets.get(idx) ?? 0) + total);
  }
}

/** One order, onto whichever of the four trend weeks holds it. */
function addToTrend(
  weekBuckets: WeekBucket[],
  status: string,
  created: Date,
  total: number
): void {
  for (const bucket of weekBuckets) {
    if (created >= bucket.start && created < bucket.end) {
      bucket.orders += 1;
      if (isRevenue(status)) bucket.revenue += total;
      break;
    }
  }
}

function addProducts(
  productMap: Map<string, OverviewProduct>,
  items: NonNullable<OrderRow["order_items"]>
): void {
  for (const item of items) {
    const key = item.name.trim() || "Item";
    const existing = productMap.get(key) ?? {
      name: key,
      qty: 0,
      revenue: 0,
    };
    existing.qty += item.qty;
    existing.revenue += item.price * item.qty;
    productMap.set(key, existing);
  }
}

function addCustomer(
  customers: Map<string, MonthCustomer>,
  row: OrderRow,
  total: number
): void {
  const { name, phone } = unwrapCustomer(row);
  const existing = customers.get(row.customer_id) ?? {
    name,
    phone,
    orders: 0,
    spent: 0,
  };
  existing.orders += 1;
  if (isRevenue(row.status)) existing.spent += total;
  if (!existing.phone && phone) existing.phone = phone;
  if (existing.name === "Customer" && name !== "Customer") {
    existing.name = name;
  }
  customers.set(row.customer_id, existing);
}

/** Customers with two or more non-cancelled orders, ever. */
function countRepeatCustomers(rows: { customer_id: string }[]): number {
  const lifetimeOrderCounts = new Map<string, number>();
  for (const row of rows) {
    lifetimeOrderCounts.set(
      row.customer_id,
      (lifetimeOrderCounts.get(row.customer_id) ?? 0) + 1
    );
  }
  let repeatCustomers = 0;
  for (const count of lifetimeOrderCounts.values()) {
    if (count >= 2) repeatCustomers += 1;
  }
  return repeatCustomers;
}

/** The oldest two trend weeks are named by date; the newest two by name. */
function trendLabel(start: Date, i: number): string {
  if (i === 2) return "Last week";
  if (i < 2) {
    return start.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    });
  }
  return "This week";
}

/** Business overview: order volume, bestsellers, and customer loyalty. */
export async function getVendorOverviewSummary(
  restaurantId: string
): Promise<VendorOverviewSummary> {
  const supabase = await createClient();
  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const lastMonthStart = startOfMonth(addIstDays(monthStart, -1));
  const trendStart = addIstDays(weekStart, -21);

  const [recentResult, lifetimeResult, pendingResult] = await Promise.all([
    // Both paged (read-all.ts): the loyalty and volume figures count rows, so a
    // read cut off at PostgREST's 1000-row cap undercounts silently.
    readAllRows((from, to) =>
      supabase
        .from("orders")
        .select(
          "id, customer_id, total, status, created_at, order_items(name, qty, price), customer:profiles!orders_customer_id_fkey(full_name, phone)"
        )
        .eq("restaurant_id", restaurantId)
        .gte("created_at", lastMonthStart.toISOString())
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to)
    ),
    readAllRows((from, to) =>
      supabase
        .from("orders")
        .select("customer_id, status")
        .eq("restaurant_id", restaurantId)
        .neq("status", "cancelled")
        .order("id")
        .range(from, to)
    ),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("restaurant_id", restaurantId)
      .in("status", [...PENDING_STATUSES]),
  ]);

  if (recentResult.error) throw recentResult.error;
  if (lifetimeResult.error) throw lifetimeResult.error;

  const rows = (recentResult.data ?? []) as OrderRow[];
  const lifetimeRows = lifetimeResult.data ?? [];

  const tally = emptyTally();
  const windows: OverviewWindows = {
    todayStart,
    weekStart,
    monthStart,
    lastMonthStart,
  };

  const amountBuckets = emptyWeekdayBuckets();
  const orderBuckets = emptyWeekdayBuckets();

  const weekBuckets: WeekBucket[] = [0, 1, 2, 3].map((offset) => {
    const start = new Date(weekStart);
    start.setDate(start.getDate() - (3 - offset) * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end, orders: 0, revenue: 0 };
  });

  const productMap = new Map<string, OverviewProduct>();
  const monthCustomerOrders = new Map<string, MonthCustomer>();

  for (const row of rows) {
    const created = new Date(row.created_at);
    const total = Number(row.total) || 0;
    const countsAsOrder = row.status !== "cancelled";

    tallyPeriods(tally, row.status, created, total, windows);
    if (created >= weekStart && countsAsOrder) {
      addToWeekday(orderBuckets, amountBuckets, row.status, created, total);
    }
    if (created >= trendStart && countsAsOrder) {
      addToTrend(weekBuckets, row.status, created, total);
    }

    // Bestsellers + top customers: this calendar month, non-cancelled
    if (created >= monthStart && countsAsOrder) {
      addProducts(productMap, row.order_items ?? []);
      addCustomer(monthCustomerOrders, row, total);
    }
  }

  const lifetimeCustomerIds = new Set(
    lifetimeRows.map((r) => r.customer_id).filter(Boolean)
  );
  const repeatCustomers = countRepeatCustomers(lifetimeRows);

  const daily: OverviewDayPoint[] = [1, 2, 3, 4, 5, 6, 0].map((dayIdx) => ({
    day: DAY_LABELS[dayIdx],
    orders: orderBuckets.get(dayIdx) ?? 0,
    revenue: amountBuckets.get(dayIdx) ?? 0,
  }));

  const weeklyTrend: OverviewWeekPoint[] = weekBuckets.map((b, i) => ({
    label: trendLabel(b.start, i),
    orders: b.orders,
    revenue: b.revenue,
  }));

  const topProducts = [...productMap.values()]
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
    .slice(0, 8);

  const topCustomers: OverviewCustomer[] = [...monthCustomerOrders.entries()]
    .map(([id, c]) => ({
      id,
      name: c.name,
      phone: c.phone,
      initials: customerInitials(c.name, c.phone),
      orders: c.orders,
      spent: c.spent,
    }))
    .sort((a, b) => b.orders - a.orders || b.spent - a.spent)
    .slice(0, 8);

  return {
    todayOrders: tally.todayOrders,
    weekOrders: tally.weekOrders,
    monthOrders: tally.monthOrders,
    lastMonthOrders: tally.lastMonthOrders,
    monthChangePercent: changePercent(tally.monthOrders, tally.lastMonthOrders),
    weekRevenue: tally.weekRevenue,
    monthRevenue: tally.monthRevenue,
    lastMonthRevenue: tally.lastMonthRevenue,
    avgOrderValue:
      tally.monthRevenueOrders > 0
        ? Math.round(tally.monthRevenue / tally.monthRevenueOrders)
        : 0,
    daily,
    weeklyTrend,
    topProducts,
    totalCustomers: lifetimeCustomerIds.size,
    customersThisMonth: monthCustomerOrders.size,
    repeatCustomers,
    topCustomers,
    completedMonth: tally.completedMonth,
    cancelledMonth: tally.cancelledMonth,
    pendingNow: pendingResult.count ?? 0,
  };
}
