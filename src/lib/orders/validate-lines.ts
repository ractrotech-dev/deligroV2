/**
 * Shape check for the basket a client sends, before any of it touches the
 * database. The client is untrusted: a quantity of 1.5, "3", 2147483647 or a
 * thousand lines would otherwise get as far as the `order_items` insert, fail
 * there, and leave a half-made order behind.
 *
 * Pure so scripts/qa/order-lines.ts can check it. The caps match the phone-order
 * path (manager-phone-orders.ts), so staff and customers cannot build a basket
 * the other side would refuse.
 */

export const MAX_ORDER_LINES = 40;
export const MAX_QTY_PER_LINE = 50;
const MAX_ITEM_ID_LENGTH = 100;
/** Add-ons on one line (0062). The database also enforces each group's max. */
export const MAX_ADDONS_PER_LINE = 20;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ITEM_ID_LENGTH;

export function areValidOrderLines(
  lines: unknown
): lines is { itemId: string; qty: number; variantId?: string; addonIds?: string[] }[] {
  if (!Array.isArray(lines)) return false;
  if (lines.length < 1 || lines.length > MAX_ORDER_LINES) return false;

  return lines.every((line) => {
    if (!line || typeof line !== "object") return false;
    const { itemId, qty, variantId, addonIds } = line as {
      itemId?: unknown;
      qty?: unknown;
      variantId?: unknown;
      addonIds?: unknown;
    };
    // Chosen options (0062): optional, ids only — never a price.
    if (variantId !== undefined && variantId !== null && !isId(variantId)) return false;
    if (
      addonIds !== undefined &&
      addonIds !== null &&
      !(Array.isArray(addonIds) && addonIds.length <= MAX_ADDONS_PER_LINE && addonIds.every(isId))
    ) {
      return false;
    }
    return (
      isId(itemId) &&
      typeof qty === "number" &&
      Number.isInteger(qty) &&
      qty >= 1 &&
      qty <= MAX_QTY_PER_LINE
    );
  });
}
