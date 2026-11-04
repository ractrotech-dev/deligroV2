import { NextResponse } from "next/server";
import { getRestaurant } from "@/lib/catalog";
import { effectivePrice } from "@/lib/utils/cart";
import { customerFeatureOn, featureOffResponse } from "@/lib/features/guards.server";

/**
 * Current price + availability for every item on one restaurant's menu.
 *
 * Exists so the client can catch a stale cart before it reaches checkout —
 * "Order again" used to copy an old order's prices straight into the cart with
 * no check against what the kitchen charges (or still serves) today. Only
 * exposes what the restaurant page already shows every customer, so this
 * needs no auth beyond the catalog's own public visibility.
 *
 * Nothing else calls it, so this is where `customer.reorder` is refused. A customer
 * can always add the same dishes from the menu by hand: that is ordinary ordering.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (!(await customerFeatureOn("customer.reorder"))) return featureOffResponse("customer.reorder");

  const { slug } = await params;

  let restaurant;
  try {
    restaurant = await getRestaurant(slug);
  } catch {
    return NextResponse.json({ ok: false, items: [] }, { status: 200 });
  }

  if (!restaurant) {
    return NextResponse.json({ ok: true, items: [] });
  }

  return NextResponse.json({
    ok: true,
    open: restaurant.open,
    items: restaurant.menu.map((item) => ({
      id: item.id,
      // The chargeable price, discount honored — what the customer would
      // actually pay again, not the pre-discount list price.
      price: effectivePrice(item.price, item.discountPrice),
      available: !item.soldOut,
    })),
  });
}
