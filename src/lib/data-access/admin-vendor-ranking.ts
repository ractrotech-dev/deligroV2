import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readAllRows } from "@/lib/data-access/read-all";
import { SLOT_COUNT } from "@/lib/data-access/vendor-positions";
import {
  MIN_RATINGS_TO_RANK,
  qualifiesFor,
  RANKING_WINDOW_DAYS,
  rankOn,
  type RankBasis,
  type VendorMetric,
  type VendorRankRow,
} from "@/lib/vendor-ranking";

export {
  MIN_RATINGS_TO_RANK,
  RANKING_WINDOW_DAYS,
  RANK_BASES,
  isRankBasis,
  type RankBasis,
  type VendorMetric,
  type VendorRankRow,
} from "@/lib/vendor-ranking";

/**
 * How shops actually perform, so the featured slots can be argued about with
 * numbers instead of instinct.
 *
 * The slots board's whole job is "which ten shops go at the top of the feed",
 * and until now it answered that with a name and a search box — nothing on the
 * screen said whether the shop in #1 sells more than the one in #7. This module
 * supplies the two signals an operator actually reasons with:
 *
 *   * sales  — gross value of delivered orders over a rolling window
 *   * rating — the catalogue rating customers see on the card
 *
 * Admins may read every order (is_admin() in the RLS policies); the service-role
 * client is used here so one query covers the whole catalogue rather than one
 * per shop. The caller MUST already be role-gated to admin — /admin's layout runs
 * `requireRole("admin")` before any page under it renders, and every export below
 * is reachable only from those pages. That gate is the authorization for the
 * createAdminClient() call (AGENTS.md §5).
 *
 * Reads degrade, writes fail loudly: a broken orders query returns a board with
 * zeroes rather than taking the slots screen down, but an auto-fill the operator
 * asked for throws so the action can say it didn't happen.
 */

/**
 * Hard ceiling on the order rows pulled for aggregation. PostgREST cannot GROUP
 * BY, so the window is summed in JS; this stops a busy month from pulling an
 * unbounded result set. When it bites, `truncated` says so and the UI repeats it
 * rather than presenting a partial sum as the total.
 */
export const ORDER_SCAN_CAP = 10000;

/** Alias kept so callers read as "performance"; the shape is the shared row. */
export type VendorPerformance = VendorRankRow;

export interface VendorRanking {
  /** Every shop, highest sales first. */
  vendors: VendorPerformance[];
  /** Same rows keyed by id, for the board's per-slot lookup. */
  byId: Record<string, VendorMetric>;
  windowDays: number;
  /** Start of the window, ISO. */
  since: string;
  /** True when ORDER_SCAN_CAP capped the aggregation. */
  truncated: boolean;
  /** How many shops could be auto-filled on each basis. */
  rankedBySales: number;
  rankedByRating: number;
}

interface RestaurantRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  status: string | null;
  approved: boolean | null;
  rating: number | string | null;
  rating_count: number | null;
  sort_position: number | null;
}

interface OrderRow {
  restaurant_id: string;
  total: number | null;
}

const EMPTY: VendorRanking = {
  vendors: [],
  byId: {},
  windowDays: RANKING_WINDOW_DAYS,
  since: "",
  truncated: false,
  rankedBySales: 0,
  rankedByRating: 0,
};

function windowStart(): Date {
  return new Date(Date.now() - RANKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Every shop with its sales, orders and rating, highest sales first.
 *
 * Never throws — the slots board must still render when the numbers can't be
 * had, because pinning does not depend on them.
 */
export async function listVendorRanking(): Promise<VendorRanking> {
  const supabase = createAdminClient();
  const since = windowStart();

  const { data: restaurants, error: rErr } = await supabase
    .from("restaurants")
    .select(
      "id, slug, name, category, status, approved, rating, rating_count, sort_position"
    )
    .order("name", { ascending: true });

  if (rErr || !restaurants) return { ...EMPTY, since: since.toISOString() };

  // Delivered only. A placed-but-cancelled order is not a sale, and counting it
  // would rank a shop that fails on every order above one that completes them.
  // Paged up to ORDER_SCAN_CAP (read-all.ts): a bare .limit(ORDER_SCAN_CAP) was
  // cut at PostgREST's 1000 rows, so `truncated` below could never be true.
  const {
    data: orders,
    error: oErr,
    truncated: scanCapped,
  } = await readAllRows(
    (from, to) =>
      supabase
        .from("orders")
        .select("restaurant_id, total")
        .eq("status", "delivered")
        .gte("created_at", since.toISOString())
        .order("id")
        .range(from, to),
    { maxRows: ORDER_SCAN_CAP }
  );

  const rows = (orders ?? []) as OrderRow[];
  const truncated = !oErr && scanCapped;

  const sales = new Map<string, number>();
  const counts = new Map<string, number>();
  if (!oErr) {
    for (const row of rows) {
      if (!row.restaurant_id) continue;
      sales.set(
        row.restaurant_id,
        (sales.get(row.restaurant_id) ?? 0) + (row.total ?? 0)
      );
      counts.set(row.restaurant_id, (counts.get(row.restaurant_id) ?? 0) + 1);
    }
  }

  const vendors: VendorPerformance[] = (restaurants as RestaurantRow[]).map(
    (r) => {
      const status = r.status ?? "active";
      const approved = r.approved ?? false;
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        category: r.category,
        status,
        approved,
        position: r.sort_position,
        sales: sales.get(r.id) ?? 0,
        orders: counts.get(r.id) ?? 0,
        rating: Number(r.rating ?? 0),
        ratingCount: r.rating_count ?? 0,
        salesRank: null,
        ratingRank: null,
        // A slot spent on a shop the feed won't show is a slot wasted — the
        // board already flags that, so auto-fill must not create it.
        eligible: approved && status === "active",
      };
    }
  );

  // Ranks are assigned over the shops that qualify on each basis, so "#3 by
  // sales" means third among shops that sold something — not third overall with
  // seven zeroes above it.
  const bySales = vendors
    .filter((v) => v.sales > 0)
    .sort((a, b) => b.sales - a.sales || b.orders - a.orders || a.name.localeCompare(b.name));
  bySales.forEach((v, i) => {
    v.salesRank = i + 1;
  });

  const byRating = vendors
    .filter((v) => v.ratingCount >= MIN_RATINGS_TO_RANK)
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        b.ratingCount - a.ratingCount ||
        a.name.localeCompare(b.name)
    );
  byRating.forEach((v, i) => {
    v.ratingRank = i + 1;
  });

  vendors.sort(
    (a, b) => b.sales - a.sales || b.orders - a.orders || a.name.localeCompare(b.name)
  );

  const byId: Record<string, VendorMetric> = {};
  for (const v of vendors) {
    byId[v.id] = {
      sales: v.sales,
      orders: v.orders,
      rating: v.rating,
      ratingCount: v.ratingCount,
      salesRank: v.salesRank,
      ratingRank: v.ratingRank,
    };
  }

  return {
    vendors,
    byId,
    windowDays: RANKING_WINDOW_DAYS,
    since: since.toISOString(),
    truncated,
    rankedBySales: bySales.filter((v) => v.eligible).length,
    rankedByRating: byRating.filter((v) => v.eligible).length,
  };
}

/**
 * The shops an auto-fill on `basis` would pin, slot 1 first.
 *
 * Only shops the feed will actually show, and only those that qualify on the
 * basis — a shop with no sales does not earn slot 8 just because slot 8 is free.
 * That means a quiet month fills fewer than ten slots, which is the honest
 * answer; the caller reports how many.
 */
export function pickSlotOrder(
  ranking: VendorRanking,
  basis: RankBasis
): VendorPerformance[] {
  return ranking.vendors
    .filter((v) => v.eligible && qualifiesFor(v, basis))
    .sort((a, b) => rankOn(a, basis) - rankOn(b, basis))
    .slice(0, SLOT_COUNT);
}
