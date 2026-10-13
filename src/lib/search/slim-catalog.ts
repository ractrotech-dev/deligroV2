import type { MenuItem, Restaurant } from "@/types";

/**
 * The catalog as the Search screen ships it to the browser.
 *
 * Search runs over every dish of every approved kitchen on the client (see
 * `dishes.ts`), so the whole catalog crosses the wire on each visit. A
 * `MenuItem` carries four flags and two numbers that are `false`, `null` or `0`
 * on almost every dish, and a serialized object pays for each key it has, not
 * for what is in it: those defaults were about a quarter of the payload.
 *
 * Every field below is optional on `MenuItem` and every reader treats "absent"
 * as the default (`item.soldOut` is a truthiness test, `effectivePrice` takes
 * `null | undefined`, ranking reads `unitsSold ?? 0`), so leaving the key out
 * is the same value for a fraction of the bytes. Nothing a customer can see,
 * search for, or be charged changes.
 */
export function slimMenuItem(item: MenuItem): MenuItem {
  const slim: MenuItem = {
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    category: item.category,
    veg: item.veg,
  };
  if (item.discountPrice != null) slim.discountPrice = item.discountPrice;
  if (item.image) slim.image = item.image;
  if (item.soldOut) slim.soldOut = true;
  if (item.popular) slim.popular = true;
  if (item.bestseller) slim.bestseller = true;
  if (item.unitsSold) slim.unitsSold = item.unitsSold;
  return slim;
}

export function slimCatalogForSearch(restaurants: Restaurant[]): Restaurant[] {
  return restaurants.map((r) => ({ ...r, menu: r.menu.map(slimMenuItem) }));
}
