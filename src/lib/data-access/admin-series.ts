import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Time series for the admin dashboard charts.
 *
 * `admin-stats` answers "how much, right now" — totals and week-over-week
 * arrows. The web dashboard also needs shape over time, which is what this
 * file supplies: one row per calendar day, gaps filled with zero.
 *
 * The zero-filling matters. A chart drawn only from days that have orders
 * silently compresses a quiet fortnight into a busy-looking line — the same
 * class of lie `admin-stats` was written to stop (it used to render invented
 * figures). A day with no orders is a real data point and is drawn as one.
 *
 * RLS does the scoping: only an admin can read other people's orders
 * (`is_admin()` in 0001_init), and the /admin layout's `requireRole("admin")`
 * has already run before any caller of this renders. No service-role client is
 * needed here, so none is used.
 */

/** One calendar day of platform activity. */
export interface DailyPoint {
  /** ISO date, `YYYY-MM-DD`, in the operator's timezone (see TZ below). */
  date: string;
  /** Short label for the axis, e.g. "8 Aug". */
  label: string;
  orders: number;
  /** Whole rupees. */
  gmv: number;
}

/** One slice of the live order mix. */
export interface StatusSlice {
  status: string;
  label: string;
  count: number;
}

export interface AdminSeries {
  days: DailyPoint[];
  /** Sum over the window — what the chart card's headline quotes. */
  totals: { orders: number; gmv: number };
  /** Busiest day in the window, or null when the window is empty. */
  peak: DailyPoint | null;
  /**
   * Orders older than `days` — always 0 for an explicit 7/14/30-day request,
   * only ever nonzero for "All time" once real history outgrows
   * `MAX_SERIES_DAYS`. The chart still stops there rather than drawing an
   * unbounded number of daily bars; this is how the page says so instead of
   * quietly showing a partial history as the complete one.
   */
  olderOrders: number;
}

/**
 * Buckets are cut in Asia/Kolkata, not UTC. An order placed at 11pm IST belongs
 * to that evening's trading day; bucketing in UTC would file it under tomorrow
 * and make every late-night order appear on the wrong bar.
 */
const TZ = "Asia/Kolkata";

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabelFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
});

function dayKey(d: Date): string {
  return dayKeyFmt.format(d); // en-CA gives YYYY-MM-DD
}

/** How far back the charts look by default. */
export const SERIES_DAYS = 30;

/**
 * "All time" — as far back as the platform's real history goes. Passed as the
 * `days` argument, distinct from any real day count.
 */
export const ALL_TIME = 0;

/**
 * The chart is one bar per day, so it cannot draw an unbounded number of them
 * legibly — or cheaply. This is the ceiling both an explicit `days` value and
 * `ALL_TIME` are clamped to; `AdminSeries.olderOrders` is how the page finds
 * out it was hit.
 */
const MAX_SERIES_DAYS = 180;

/**
 * Daily orders and GMV for the last `days` days, oldest first, zero-filled.
 * `ALL_TIME` asks for the whole history, capped at `MAX_SERIES_DAYS`.
 *
 * Returns an empty-but-complete series on failure rather than throwing: a
 * missing chart is recoverable, a dashboard that 500s because one aggregate
 * query failed is not.
 */
export async function getAdminSeries(
  days = SERIES_DAYS,
  restaurantId?: string
): Promise<AdminSeries> {
  const span =
    days === ALL_TIME ? MAX_SERIES_DAYS : Math.max(1, Math.min(days, MAX_SERIES_DAYS));

  // Build the buckets first, so the shape of the answer never depends on what
  // came back from the database.
  const buckets = new Map<string, DailyPoint>();
  const now = Date.now();
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    buckets.set(dayKey(d), {
      date: dayKey(d),
      label: dayLabelFmt.format(d),
      orders: 0,
      gmv: 0,
    });
  }

  const since = new Date(now - span * 86_400_000).toISOString();
  let olderOrders = 0;

  try {
    const supabase = await createClient();
    let query = supabase
      .from("orders")
      .select("total, created_at")
      .gte("created_at", since)
      .order("created_at");
    if (restaurantId) query = query.eq("restaurant_id", restaurantId);
    const { data, error } = await query;

    if (!error) {
      for (const row of (data ?? []) as {
        total: number | null;
        created_at: string;
      }[]) {
        const bucket = buckets.get(dayKey(new Date(row.created_at)));
        // Orders just outside the window (clock skew, the partial first day)
        // have no bucket. Dropping them is correct — inventing one is not.
        if (!bucket) continue;
        bucket.orders += 1;
        bucket.gmv += Number(row.total ?? 0);
      }
    }

    // Only worth asking for "All time": an explicit 7/14/30-day request was
    // never claiming to be complete, so there is nothing to disclose.
    if (days === ALL_TIME) {
      let older = supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .lt("created_at", since);
      // Scoped the same way as the series itself, or the disclosure would
      // count every shop's history against one shop's chart.
      if (restaurantId) older = older.eq("restaurant_id", restaurantId);
      const { count } = await older;
      olderOrders = count ?? 0;
    }
  } catch {
    // Fall through to the zero-filled series.
  }

  const list = [...buckets.values()];
  const totals = list.reduce(
    (acc, d) => ({ orders: acc.orders + d.orders, gmv: acc.gmv + d.gmv }),
    { orders: 0, gmv: 0 }
  );
  const peak = list.reduce<DailyPoint | null>(
    (best, d) => (d.orders > (best?.orders ?? -1) ? d : best),
    null
  );

  return {
    days: list,
    totals,
    peak: totals.orders > 0 ? peak : null,
    olderOrders,
  };
}

/** Customer-facing stage labels, matching the Orders screen's pills. */
const STATUS_LABELS: Record<string, string> = {
  placed: "Placed",
  kitchen: "Preparing",
  ready: "Ready",
  on_the_way: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** Draw order, so the donut's slices don't jump around between renders. */
const STATUS_ORDER = [
  "placed",
  "kitchen",
  "ready",
  "on_the_way",
  "delivered",
  "cancelled",
];

/**
 * How the last `days` days of orders ended up, by stage — the donut's data.
 * Stages with no orders are omitted; a window with nothing in it returns [].
 *
 * `ALL_TIME` reads every order ever placed. Unlike the daily chart, a status
 * count has no per-bucket rendering cost to protect — it's one column, summed
 * — so there is no cap to disclose here.
 */
export async function getOrderStatusMix(
  days = 7,
  restaurantId?: string
): Promise<StatusSlice[]> {
  const since =
    days === ALL_TIME
      ? null
      : new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();

  let rows: { status: string | null }[] = [];
  try {
    const supabase = await createClient();
    let query = supabase.from("orders").select("status");
    if (since) query = query.gte("created_at", since);
    if (restaurantId) query = query.eq("restaurant_id", restaurantId);
    const { data, error } = await query;
    if (error) return [];
    rows = (data ?? []) as { status: string | null }[];
  } catch {
    return [];
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.status ?? "placed";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return STATUS_ORDER.filter((s) => counts.has(s)).map((status) => ({
    status,
    label: STATUS_LABELS[status] ?? status,
    count: counts.get(status) ?? 0,
  }));
}

/* ============================================================
   Payment mix
   ============================================================ */

/** One slice of "how did people pay". */
export interface PaymentSlice {
  method: "cod" | "online";
  label: string;
  count: number;
  /** Gross value of those orders, whole rupees. */
  gmv: number;
}

/**
 * Cash against online, over the last `days` days.
 *
 * Both halves are asked for because they answer different questions. The count
 * is an operations figure — how many doorstep cash handovers the riders are
 * carrying, which is what `cash-ledger` reconciles. The value is a treasury
 * figure — how much of the platform's takings arrives as money somebody has to
 * physically move, versus money that is already in an account.
 *
 * Both slices are always returned, at zero if need be. Unlike the status mix,
 * where an absent stage is genuinely nothing to say, "no cash orders this
 * week" is a real and useful answer about a two-valued split, and dropping the
 * slice would make the bar read as 100% of a single method with no indication
 * that the other exists.
 *
 * Cancelled orders are excluded. A cancelled order was never paid by either
 * method, so counting it would inflate whichever one the customer had merely
 * intended to use.
 *
 * Fails to an empty split rather than throwing: same rule as everything else
 * in this file — a missing panel is recoverable, a dashboard that 500s because
 * one aggregate failed is not.
 */
export async function getPaymentMix(
  days = 7,
  restaurantId?: string
): Promise<PaymentSlice[]> {
  const since =
    days === ALL_TIME
      ? null
      : new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();

  const empty: PaymentSlice[] = [
    { method: "cod", label: "Cash on delivery", count: 0, gmv: 0 },
    { method: "online", label: "Paid online", count: 0, gmv: 0 },
  ];

  let rows: { payment_method: string | null; total: number | null }[] = [];
  try {
    const supabase = await createClient();
    let query = supabase
      .from("orders")
      .select("payment_method, total")
      .neq("status", "cancelled");
    if (since) query = query.gte("created_at", since);
    if (restaurantId) query = query.eq("restaurant_id", restaurantId);
    const { data, error } = await query;
    if (error) return empty;
    rows = (data ?? []) as typeof rows;
  } catch {
    return empty;
  }

  for (const row of rows) {
    // `payment_method` is a 0025 enum and non-null in practice, but an order
    // imported before that migration has nothing there. Cash is the honest
    // default for this platform — it is what an order with no recorded online
    // payment was — and it is also the direction that over-states the figure a
    // human has to go and reconcile, rather than under-stating it.
    const slice = row.payment_method === "online" ? empty[1] : empty[0];
    slice.count += 1;
    slice.gmv += Math.round(Number(row.total) || 0);
  }

  return empty;
}
