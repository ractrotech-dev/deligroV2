import type { CartLine, Order } from "@/types";

/**
 * Rebuild cart lines from a past order.
 *
 * `veg` comes from the order's own snapshot (order_items → menu_items.veg), and
 * stays undefined when the dish is no longer on the menu. It used to be looked
 * up in the MOCK catalog and defaulted to `true` on a miss — and against a real
 * database that lookup missed every time, so reordering a chicken biryani put a
 * green vegetarian mark next to it. A dietary claim we can't substantiate is one
 * we don't make.
 */
/**
 * What a dish actually costs, honoring an admin-set discount price.
 *
 * A discount is only real when it's a lower whole-rupee amount than the base
 * price — a null/negative/equal-or-higher `discountPrice` is a bad or unset
 * value, not a discount, so it charges (and shows) the base price instead.
 * Shared by the cart (what gets added), the storefront price display, and
 * `createOrder` (what gets charged), so all three can never disagree.
 */
export function effectivePrice(
  price: number,
  discountPrice: number | null | undefined
): number {
  if (discountPrice == null) return price;
  if (discountPrice < 0 || discountPrice >= price) return price;
  return discountPrice;
}

/**
 * A customised line (a size or add-ons, 0062) is left out: the ids it was
 * ordered with may have changed since, and the order-line guard refuses a dish
 * with sizes but none chosen. `customisedLineNames` names them so the customer
 * is told to choose again rather than finding them silently missing.
 */
export function orderLinesToCartLines(order: Order): CartLine[] {
  return order.lines.filter((l) => !l.customised).map((l) => ({
    itemId: l.itemId,
    name: l.name,
    price: l.price,
    qty: l.qty,
    veg: l.veg,
  }));
}

/** One current menu item's price/availability, as returned by GET /api/restaurants/[slug]/menu-prices. */
export interface CurrentMenuItem {
  id: string;
  price: number;
  available: boolean;
}

export interface ReorderDiff {
  /** Lines to actually put in the cart — unavailable items dropped, prices refreshed. */
  lines: CartLine[];
  /** Names dropped because the item is sold out or gone from the menu. */
  removed: string[];
  /** Customised dishes to add again from the menu (see orderLinesToCartLines). */
  rechoose?: string[];
  /** Items whose price changed since the original order. */
  repriced: { name: string; oldPrice: number; newPrice: number }[];
}

/**
 * Reconcile a past order's lines against what the kitchen actually serves and
 * charges today, before they land in the cart. `current` is keyed by menu item
 * id; an id with no entry means the dish no longer exists on this menu at all.
 */
export function reconcileReorder(
  lines: CartLine[],
  current: CurrentMenuItem[]
): ReorderDiff {
  const byId = new Map(current.map((c) => [c.id, c]));
  const removed: string[] = [];
  const repriced: ReorderDiff["repriced"] = [];

  const kept = lines.flatMap((l) => {
    const now = byId.get(l.itemId);
    if (!now?.available) {
      removed.push(l.name);
      return [];
    }
    if (now.price !== l.price) {
      repriced.push({ name: l.name, oldPrice: l.price, newPrice: now.price });
    }
    return [{ ...l, price: now.price }];
  });

  return { lines: kept, removed, repriced };
}

export function customisedLineNames(order: Order): string[] {
  return order.lines.filter((l) => l.customised).map((l) => l.name);
}

/** A basket line's identity: its dish and chosen options (lines saved before options existed have no key). */
export function cartLineKey(line: Pick<CartLine, "itemId" | "key">): string {
  return line.key ?? line.itemId;
}
