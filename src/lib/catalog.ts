import "server-only";
import { cache } from "react";
import {
  RESTAURANTS,
  getRestaurant as getMockRestaurant,
} from "@/lib/data";
import {
  getRestaurantFromDb,
  listRestaurantsFromDb,
} from "@/lib/data-access/restaurants";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { Restaurant } from "@/types";

/**
 * Server facade: live Supabase catalog when configured and seeded,
 * otherwise Phase 1 mock data (demo mode).
 */

/**
 * A catalog read that says whether it worked.
 *
 * `listRestaurants()` used to swallow every exception and return `[]`, which the
 * storefront renders as "we haven't onboarded a store near you" — a confident
 * statement about the customer's city, made on the strength of a failed query.
 * The two states look identical to a caller and are nothing alike, so they are
 * now distinguishable and the UI says which one it is looking at.
 */
export interface CatalogResult {
  restaurants: Restaurant[];
  /** False when the read failed. `restaurants` is then empty but meaningless. */
  ok: boolean;
}

export async function listRestaurantsResult(
  opts: { withMenu?: boolean } = {}
): Promise<CatalogResult> {
  if (!isSupabaseConfigured) return { restaurants: RESTAURANTS, ok: true };

  try {
    return { restaurants: await listRestaurantsFromDb(opts.withMenu), ok: true };
  } catch (err) {
    console.error("[catalog] listRestaurants failed", err);
    return { restaurants: [], ok: false };
  }
}

/**
 * A failed read of one restaurant.
 *
 * Thrown rather than returned as undefined, because the restaurant page maps
 * undefined to `notFound()` — so a backend fault used to 404 a real, live
 * restaurant. Mirrors `OrderReadFailed` in `lib/orders-ui.ts` for the same
 * reason: "this restaurant doesn't exist" and "we couldn't reach the
 * database" are different sentences, and the customer deserves the right one.
 */
class RestaurantReadFailed extends Error {
  constructor(readonly cause?: unknown) {
    super("restaurant_read_failed");
    this.name = "RestaurantReadFailed";
  }
}

/**
 * `cache()` dedupes this within a single request — the restaurant page calls
 * it once for `generateMetadata` and once for the page body, and used to pay
 * for the DB read twice for the same row on every view.
 */
export const getRestaurant = cache(
  async (slug: string): Promise<Restaurant | undefined> => {
    if (!isSupabaseConfigured) return getMockRestaurant(slug);

    try {
      const live = await getRestaurantFromDb(slug);
      return live ?? undefined;
    } catch (err) {
      console.error("[catalog] getRestaurant failed", err);
      throw new RestaurantReadFailed(err);
    }
  }
);

