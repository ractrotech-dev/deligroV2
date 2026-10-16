/**
 * The rules behind "which shop is doing better", in a module both the server and
 * the client can read — the data layer ranks by them, the slots board quotes them
 * back to the operator. Same arrangement as `popularity.ts`, and for the same
 * reason: a caption that disagrees with the ranking is worse than no caption.
 *
 * The queries themselves live in `data-access/admin-vendor-ranking.ts`, which is
 * server-only. Nothing here touches the database, so the board can import the
 * types and the window length without pulling a server module into the client.
 */

/** Rolling window the sales ranking counts delivered orders over. */
export const RANKING_WINDOW_DAYS = 30;

/**
 * Below this many ratings a shop is not ranked by rating at all.
 *
 * `restaurants.rating` defaults to 4.5 with a `rating_count` of 0 (migration
 * 0002), so an untouched catalogue is a field of tied 4.5s. Ranking on that would
 * present seed data as customer opinion — the UI says "not enough ratings".
 */
export const MIN_RATINGS_TO_RANK = 5;

/** What an auto-fill orders the slots by. */
export type RankBasis = "sales" | "rating";

export function isRankBasis(value: unknown): value is RankBasis {
  return value === "sales" || value === "rating";
}

/** One shop's numbers, as the slots board shows them. */
export interface VendorMetric {
  /** Gross value of delivered orders in the window, whole rupees. */
  sales: number;
  /** Delivered order count in the window. */
  orders: number;
  /** The catalogue rating on the customer's card. */
  rating: number;
  ratingCount: number;
  /** 1 = highest sales. null when the shop sold nothing in the window. */
  salesRank: number | null;
  /** 1 = highest rating. null below MIN_RATINGS_TO_RANK. */
  ratingRank: number | null;
}

/** A shop plus its numbers — one row of the ranking table. */
export interface VendorRankRow extends VendorMetric {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  status: string;
  approved: boolean;
  /** The slot it currently holds, or null. */
  position: number | null;
  /** Eligible to be auto-filled — the feed will actually show it. */
  eligible: boolean;
}

/**
 * Why a shop cannot be auto-filled, phrased for the operator, or null when it
 * can. Lives beside the `eligible` flag it explains so the two cannot disagree.
 */
export function ineligibleReason(row: VendorRankRow): string | null {
  if (!row.approved) return "Not approved — never appears on the feed";
  if (row.status !== "active") return `Status is ${row.status}`;
  return null;
}

/** Whether a shop qualifies to be ranked on a basis at all. */
export function qualifiesFor(row: VendorRankRow, basis: RankBasis): boolean {
  return basis === "sales" ? row.salesRank != null : row.ratingRank != null;
}

/** A shop's rank on a basis, or Infinity when it does not qualify. */
export function rankOn(row: VendorRankRow, basis: RankBasis): number {
  const rank = basis === "sales" ? row.salesRank : row.ratingRank;
  return rank ?? Number.POSITIVE_INFINITY;
}
