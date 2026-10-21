import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { loadMetricOrders } from "@/lib/data-access/ops-metrics";
import type { ManagerScope } from "@/lib/auth/manager-scope";
import { adminPulse } from "@/lib/metrics/admin";
import { istDayKey } from "@/lib/metrics/ist";
import type { MetricOrder } from "@/lib/metrics/types";

const ALL_ZONES: ManagerScope = { all: true };
import { assertCanGoLive } from "@/lib/vendors/readiness";
import { startOfIstDay } from "@/lib/utils/ist-time";

export interface PendingRestaurant {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

/** A period-over-period movement: the % change and which way it points. */
export interface Trend {
  /** Signed percentage change, one decimal. 0 when flat or immeasurable. */
  pct: number;
  direction: "up" | "down" | "flat";
}

export interface AdminDashboard {
  totals: {
    shops: number;
    users: number;
    drivers: number;
    orders: number;
  };
  today: {
    orders: number;
    gmv: number;
    activeRiders: number;
    pendingApprovals: number;
    /**
     * The orders read behind today's revenue, orders and the order/revenue
     * trends failed. The page shows "—" and says so: ₹0 would be a figure
     * someone acts on.
     */
    salesUnavailable: boolean;
  };
  /** This week vs the week before — the arrows on the total cards. */
  trends: {
    shops: Trend;
    users: Trend;
    orders: Trend;
    gmv: Trend;
  };
}

export function startOfToday(): string {
  // IST midnight, not the server's. `setHours(0,0,0,0)` is local to the host,
  // which is UTC on Vercel, so "today" began at 05:30 IST and the dashboard
  // showed yesterday's evening orders until then.
  return startOfIstDay().toISOString();
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Growth of `curr` over `prev`. A jump from nothing reads as up, not ∞. */
export function trend(curr: number, prev: number): Trend {
  if (prev <= 0) {
    if (curr <= 0) return { pct: 0, direction: "flat" };
    return { pct: 100, direction: "up" };
  }
  const pct = ((curr - prev) / prev) * 100;
  let direction: Trend["direction"] = "flat";
  if (pct > 0.5) direction = "up";
  else if (pct < -0.5) direction = "down";
  return { pct: Math.round(pct * 10) / 10, direction };
}

/** A head+count query, hardened to return a plain number. */
async function countOf(
  build: () => PromiseLike<{ count: number | null; error: unknown }>
): Promise<number> {
  try {
    const { count, error } = await build();
    return error ? 0 : count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The whole admin overview in one shot: platform totals, today's pulse, and the
 * week-over-week trend arrows. Every figure is counted from the database; a
 * failing sub-query resolves to 0 rather than throwing, so one missing table
 * can't blank the entire dashboard.
 */
export async function getAdminDashboard(): Promise<AdminDashboard> {
  // The order figures below read with the service role (ops-metrics.ts), so
  // this checks for itself rather than trusting the layout (AGENTS.md rule 5).
  await requireRole("admin");
  const supabase = await createClient();
  const now = new Date();
  const d7 = daysAgo(7);
  const d14 = daysAgo(14);

  const [
    shops,
    users,
    drivers,
    orders,
    pendingApprovals,
    shopsCurr,
    shopsPrev,
    usersCurr,
    usersPrev,
    riders,
    recentOrders,
  ] = await Promise.all([
    countOf(() =>
      supabase
        .from("restaurants")
        .select("id", { count: "exact", head: true })
        .eq("approved", true)
    ),
    countOf(() =>
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "customer")
    ),
    countOf(() =>
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "driver")
    ),
    countOf(() =>
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .neq("status", "cancelled")
    ),
    // Shops nobody has ruled on yet. Not `approved = false`: the 0017 trigger
    // un-approves anything that leaves 'active', so a disabled or rejected
    // vendor would sit in this count with no action left that could clear it.
    countOf(() =>
      supabase
        .from("restaurants")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
    ),
    // Restaurants onboarded this week vs last.
    countOf(() =>
      supabase
        .from("restaurants")
        .select("id", { count: "exact", head: true })
        .gte("created_at", d7)
    ),
    countOf(() =>
      supabase
        .from("restaurants")
        .select("id", { count: "exact", head: true })
        .gte("created_at", d14)
        .lt("created_at", d7)
    ),
    // New customers this week vs last.
    countOf(() =>
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "customer")
        .gte("created_at", d7)
    ),
    countOf(() =>
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "customer")
        .gte("created_at", d14)
        .lt("created_at", d7)
    ),
    // Riders mid-delivery right now.
    supabase
      .from("deliveries")
      .select("driver_id")
      .in("status", ["assigned", "picked_up"]),
    // One 15-IST-day pull covers order + GMV trends and today's figures, summed
    // by the shared ops metrics so this tile and the manager dashboard's
    // "Today's Total Sales" are one number (design §18.4). A failed read is
    // reported as unavailable, never as zeros.
    loadMetricOrders(ALL_ZONES, {
      range: { from: istDayKey(new Date(now.getTime() - 15 * 86_400_000)), to: istDayKey(now) },
    }).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const, rows: [] as MetricOrder[] })
    ),
  ]);

  const pulse = adminPulse(recentOrders.rows, now);
  const salesUnavailable = !recentOrders.ok;
  const ordersToday = pulse.ordersToday;
  const gmvToday = pulse.gmvToday;
  const { curr: ordersCurr, prev: ordersPrev } = pulse.orders;
  const { curr: gmvCurr, prev: gmvPrev } = pulse.gmv;

  const activeRiders = new Set(
    (riders.data ?? [])
      .map((d) => (d as { driver_id: string | null }).driver_id)
      .filter(Boolean)
  ).size;

  return {
    totals: { shops, users, drivers, orders },
    today: { orders: ordersToday, gmv: gmvToday, activeRiders, pendingApprovals, salesUnavailable },
    trends: {
      shops: trend(shopsCurr, shopsPrev),
      users: trend(usersCurr, usersPrev),
      orders: trend(ordersCurr, ordersPrev),
      gmv: trend(gmvCurr, gmvPrev),
    },
  };
}

/**
 * The three numbers the web shell's sidebar and top bar wear as badges.
 *
 * Every one is a real queue an operator can act on — approvals waiting, refunds
 * waiting, orders currently in flight. A badge that isn't counted from the
 * database is a badge that lies about how much work there is, so a failing
 * sub-query reads as 0 (nothing to do) rather than as a guess.
 *
 * Runs on every admin page render, so all three are head-only counts.
 */
export interface AdminNavCounts {
  pendingApprovals: number;
  pendingRefunds: number;
  liveOrders: number;
}

/** Stages where an order still needs somebody to do something. */
const IN_FLIGHT = ["placed", "kitchen", "ready", "on_the_way"];

export async function getAdminNavCounts(): Promise<AdminNavCounts> {
  const supabase = await createClient();

  const [pendingApprovals, pendingRefunds, liveOrders] = await Promise.all([
    // Shops nobody has ruled on yet. Not `approved = false`: the 0017 trigger
    // un-approves anything that leaves 'active', so a disabled or rejected
    // vendor would sit in this count with no action left that could clear it.
    countOf(() =>
      supabase
        .from("restaurants")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
    ),
    countOf(() =>
      supabase
        .from("refunds")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
    ),
    countOf(() =>
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .in("status", IN_FLIGHT)
    ),
  ]);

  return { pendingApprovals, pendingRefunds, liveOrders };
}

/**
 * Orders whose payment was attempted and failed.
 *
 * `payment_status` only leaves `pending` on a verified Razorpay signature
 * (0025), so `failed` is a real, decided outcome — a customer who tried to pay
 * and could not — rather than a payment still in flight. That makes it a queue
 * somebody has to work, which is why the dashboard's attention centre lists it.
 *
 * Deliberately *not* part of `getAdminNavCounts`. Those three counts are read
 * by the layout on every single admin page render because the rail badges need
 * them; this one is read by one screen, and adding it there would buy a fourth
 * count query on forty-five pages to serve one.
 *
 * Cancelled orders are excluded: a failed payment on an order that was then
 * cancelled has already been resolved by the cancellation, and leaving it in
 * the queue would mean a number that never goes down.
 *
 * Returns 0 on any failure. A count that cannot be read is not evidence of a
 * problem, and inventing one would put a permanent red figure on the dashboard.
 */
export async function getFailedPaymentCount(): Promise<number> {
  try {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("payment_status", "failed")
      .neq("status", "cancelled");
    return error ? 0 : count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Restaurants waiting on an admin — the real queue, not a hardcoded list.
 *
 * 'pending' is the undecided state; approving makes a shop active and rejecting
 * suspends it, and both leave this list. See `listAwaitingApproval`.
 */
export async function listPendingRestaurants(): Promise<PendingRestaurant[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("id, name, slug, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((r) => {
    const row = r as { id: string; name: string; slug: string; created_at: string };
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.created_at,
    };
  });
}

/**
 * Approve a restaurant so its storefront goes live. Admin-only via RLS.
 *
 * The second door into "live": `approved` and `status` are kept in step by the
 * 0017 trigger, so setting one activates the shop as surely as setting the
 * other. It carries the same pin requirement for that reason — guarding only
 * `setVendorStatus` would have been a detour rather than a gate. See
 * `lib/vendors/readiness.ts`.
 */
export async function approveRestaurant(id: string): Promise<void> {
  const supabase = await createClient();

  const { data, error: readError } = await supabase
    .from("restaurants")
    .select("name, lat, lng")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (data) assertCanGoLive(data, data.name ?? "This shop");

  const { error } = await supabase
    .from("restaurants")
    .update({ approved: true })
    .eq("id", id);

  if (error) throw error;
}
