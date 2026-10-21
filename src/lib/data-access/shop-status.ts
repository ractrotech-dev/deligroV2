import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isShopStatus, type ShopStatus } from "@/lib/orders/order-options";

/** null = not asked yet; false once the function is known to be missing. */
let supported: boolean | null = null;

/**
 * Whether each shop is taking orders right now and, if not, why: the one
 * definition order placement also uses (0062 restaurant_status_now: the
 * owner's switch, a timed close, holidays, weekly off, opening hours).
 *
 * An empty map on a database without 0062 or on any failure: the storefront
 * then falls back to `is_open`, and order placement still refuses a closed
 * shop on its own.
 */
export async function liveShopStatuses(ids: string[]): Promise<Map<string, ShopStatus>> {
  const out = new Map<string, ShopStatus>();
  if (ids.length === 0 || supported === false) return out;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("restaurant_open_statuses", { p_ids: ids });
  if (error) {
    // PGRST202: PostgREST has no such function, so 0062 isn't applied.
    if (error.code === "PGRST202" || error.code === "42883") supported = false;
    return out;
  }
  supported = true;
  for (const row of (data ?? []) as { restaurant_id: string; status: string }[]) {
    if (isShopStatus(row.status)) out.set(row.restaurant_id, row.status);
  }
  return out;
}
