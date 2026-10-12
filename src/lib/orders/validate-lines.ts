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

export function areValidOrderLines(
  lines: unknown
): lines is { itemId: string; qty: number }[] {
  if (!Array.isArray(lines)) return false;
  if (lines.length < 1 || lines.length > MAX_ORDER_LINES) return false;

  return lines.every((line) => {
    if (!line || typeof line !== "object") return false;
    const { itemId, qty } = line as { itemId?: unknown; qty?: unknown };
    return (
      typeof itemId === "string" &&
      itemId.length > 0 &&
      itemId.length <= MAX_ITEM_ID_LENGTH &&
      typeof qty === "number" &&
      Number.isInteger(qty) &&
      qty >= 1 &&
      qty <= MAX_QTY_PER_LINE
    );
  });
}
