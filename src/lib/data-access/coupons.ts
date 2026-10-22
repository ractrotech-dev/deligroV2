import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Coupon *pricing* — the preview half of the feature.
 *
 * This says what a code would be worth. It does not apply anything, and
 * nothing it returns is billed. The authority is `apply_coupon_to_order()`
 * (0031, rewritten in 0041), which re-derives the amount from the order's own
 * `order_items` inside one transaction that also records the redemption.
 *
 * Since 0041 this file no longer computes anything. It used to re-implement
 * the percentage-and-ceiling arithmetic in TypeScript alongside the copy in
 * SQL, and the two had already drifted — the TS side never checked
 * `max_redemptions`, and could not check the restaurant because nothing told
 * it which one. Both now call `price_coupon()`; this is a thin caller of the
 * `preview_coupon()` RPC that wraps it.
 *
 * That also closed a hole. Reading `coupons` directly meant the table had to
 * be SELECT-able by the session, and the 0006 policy handed every active code
 * to anyone who asked — anon included — which made the route's session
 * requirement and 20/minute rate limit decorative. The RPC answers about one
 * code the caller already named, and the table is no longer readable.
 *
 * Two callers, deliberately:
 *   * `/api/coupons/validate` — the checkout's "apply code" button.
 *   * `createOrder()` — a last check before anything is written, because an
 *     order cannot be rolled back once it exists.
 */

export interface CouponResult {
  ok: boolean;
  error?: string;
  code?: string;
  /** Rupees off. On a `min_order` failure this carries the minimum instead. */
  discount?: number;
  /** Who absorbs it — `"vendor"` or `"platform"`. Set only when `ok`. */
  fundedBy?: string;
}

/**
 * @param code         what the customer typed.
 * @param subtotal     food only, in rupees. Advisory: the redemption re-reads
 *                     the order's items rather than trusting this.
 * @param restaurantId the shop being ordered from. A coupon scoped to another
 *                     shop is refused here rather than at submit, so the
 *                     customer finds out while they can still do something.
 * @param items        the basket's dishes and quantities, when the caller has
 *                     them (checkout). Errors then also include `not_started`,
 *                     `wrong_zone` and `no_eligible_items`.
 */
export async function evaluateCoupon(
  code: string,
  subtotal: number,
  restaurantId: string,
  items?: { menuItemId: string; qty: number }[]
): Promise<CouponResult> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { ok: false, error: "empty" };

  const supabase = await createClient();
  // With the basket (0161): priced from the dishes' server prices, so a code
  // limited to some dishes previews exactly what the bill will take off.
  const { data, error } = items
    ? await supabase.rpc("preview_coupon", { p_code: normalized, p_restaurant: restaurantId, p_items: items })
    : await supabase.rpc("preview_coupon", {
        coupon: normalized,
        subtotal: Math.max(0, Math.round(subtotal)),
        rid: restaurantId,
      });

  // A database that has not run 0041 has no such function. Refusing the code is the
  // right direction: the alternative is guessing at a discount the redemption
  // would then have to honour or contradict.
  if (error || !data) return { ok: false, error: "invalid" };

  const result = data as {
    ok: boolean;
    error?: string;
    code?: string;
    discount?: number;
    minOrder?: number;
    fundedBy?: string;
  };

  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? "invalid",
      // `min_order` reports the minimum in the same field the success path
      // uses for the discount — the shape the callers already expect.
      discount: result.minOrder,
    };
  }

  return {
    ok: true,
    code: result.code ?? normalized,
    discount: Number(result.discount ?? 0),
    fundedBy: result.fundedBy,
  };
}
