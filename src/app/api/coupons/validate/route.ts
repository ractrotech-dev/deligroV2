import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { evaluateCoupon } from "@/lib/data-access/coupons";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { parseBasket, resolveBasket, UUID_RE } from "@/lib/coupons/basket";

/** POST /api/coupons/validate  { code, subtotal, restaurantSlug } → { discount } */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });

  // Only a signed-in customer is ever about to check out, and requiring a
  // session turns "enumerate the whole promo-code namespace anonymously" into
  // an attributable, rate-limited action against a known account. Since 0041
  // the table itself is unreadable and the lookup goes through preview_coupon(),
  // so this is now the outer of two locks rather than the only one.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimit(`coupon-validate:${user.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: { code?: string; subtotal?: number; restaurantSlug?: string; items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body.code || typeof body.subtotal !== "number" || !body.restaurantSlug) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  // The client names a shop by slug and the id is looked up here. A code scoped
  // to another restaurant has to be refused at the preview or the customer only
  // finds out at submit, with the discount already in their head — and the
  // basket only knows its slug, so the resolution belongs on this side.
  //
  // Nothing rides on the client being honest about which shop: the redemption
  // re-checks the scope against the order's own `restaurant_id`. Naming the
  // wrong slug here buys a preview that the bill then contradicts.
  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("id")
    .eq("slug", body.restaurantSlug)
    .maybeSingle();
  if (!restaurant) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  // Optional basket (0161): dish-limited codes discount only their dishes.
  let items: { menuItemId: string; qty: number }[] | undefined;
  if (body.items !== undefined) {
    const parsed = parseBasket(body.items);
    if (!parsed) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    // The cart names dishes by external_id (or uuid for vendor-added ones);
    // pricing wants the shop's menu item uuids.
    const refs = [...new Set(parsed.map((l) => l.menuItemId))];
    const uuids = refs.filter((r) => UUID_RE.test(r));
    const externals = refs.filter((r) => !UUID_RE.test(r));
    const reads = await Promise.all([
      uuids.length ? supabase.from("menu_items").select("id, external_id").eq("restaurant_id", restaurant.id).in("id", uuids) : null,
      externals.length ? supabase.from("menu_items").select("id, external_id").eq("restaurant_id", restaurant.id).in("external_id", externals) : null,
    ]);
    const dishes = reads.flatMap((r) => ((r?.data ?? []) as { id: string; external_id: string | null }[]));
    items = resolveBasket(parsed, dishes);
  }

  const result = await evaluateCoupon(body.code, body.subtotal, restaurant.id, items);
  if (!result.ok) return NextResponse.json({ error: result.error, minOrder: result.discount }, { status: 400 });
  return NextResponse.json({ ok: true, code: result.code, discount: result.discount });
}

