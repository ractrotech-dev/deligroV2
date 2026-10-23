/**
 * The basket a coupon preview may be priced against (0161). Pure.
 *
 * A line names its dish the way the cart does: the menu item's `external_id`,
 * or its uuid for a dish the vendor added. The route resolves both to uuids
 * for the shop before pricing (see `basketItemIds`).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BasketLine { menuItemId: string; qty: number }

/** At most 100 lines of { menuItemId: 1–80 chars, qty: 1–50 }; anything else is refused. */
export function parseBasket(v: unknown): BasketLine[] | null {
  if (!Array.isArray(v) || v.length > 100) return null;
  const out: BasketLine[] = [];
  for (const line of v) {
    if (!line || typeof line !== "object") return null;
    const { menuItemId, qty } = line as { menuItemId?: unknown; qty?: unknown };
    if (typeof menuItemId !== "string" || menuItemId.length < 1 || menuItemId.length > 80) return null;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 50) return null;
    out.push({ menuItemId, qty });
  }
  return out;
}

/** Map each line's dish reference to the shop's menu item uuid; unknown dishes are dropped. */
export function resolveBasket(lines: BasketLine[], dishes: { id: string; external_id: string | null }[]): BasketLine[] {
  const byRef = new Map<string, string>();
  for (const d of dishes) {
    byRef.set(d.id.toLowerCase(), d.id);
    if (d.external_id) byRef.set(d.external_id, d.id);
  }
  return lines.flatMap((l) => {
    const id = byRef.get(UUID_RE.test(l.menuItemId) ? l.menuItemId.toLowerCase() : l.menuItemId);
    return id ? [{ menuItemId: id, qty: l.qty }] : [];
  });
}
