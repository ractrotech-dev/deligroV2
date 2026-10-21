/**
 * QA — order placement with 0062: line prices with variants and add-ons (must
 * match the order-line guard), closed-shop messages, guard refusals → reasons,
 * and the basket shape check for the new fields.
 *
 * Runs offline. Usage: npx tsx scripts/qa/order-options.ts
 */
import { areValidOrderLines } from "../../src/lib/orders/validate-lines";
import { clockLabel, closedMessage, linePrice, refusalFromItemError } from "../../src/lib/orders/order-options";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === "object" ? JSON.stringify(actual) : actual;
  const e = typeof expected === "object" ? JSON.stringify(expected) : expected;
  if (Object.is(a, e)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(e)}, got ${String(a)}`);
  }
}

console.log("\n═══ Line prices (same as guard_order_item_insert) ═══");
check("no options: the effective price", linePrice({ price: 200, discount_price: 180 }, null, []), 180);
check("a variant replaces the price, discount and all", linePrice({ price: 200, discount_price: 180 }, { price: 350 }, []), 350);
check("add-ons add on", linePrice({ price: 200, discount_price: null }, { price: 350 }, [{ price: 40 }, { price: 20 }]), 410);

console.log("\n═══ Closed-shop messages ═══");
check("clock label", clockLabel("09:30:00"), "9:30 AM");
check("clock label afternoon", clockLabel("18:05:00"), "6:05 PM");
check("midnight", clockLabel("00:00:00"), "12:00 AM");
check("outside hours names the opening time", closedMessage("outside_hours", "11:00:00", "en"), "This shop is closed right now. It opens at 11:00 AM.");
check("holiday", closedMessage("holiday", null, "en"), "This shop is closed today for a holiday.");
check("in Hindi too", closedMessage("weekly_off", null, "hi"), "यह दुकान आज बंद रहती है।");

console.log("\n═══ Guard refusals → reasons ═══");
check("closed", refusalFromItemError("order_items: restaurant_closed (holiday)", "en")?.code, "restaurant_closed");
check("stock, with the dish and count", refusalFromItemError("order_items: only 2 left of Paneer Tikka", "en"), {
  code: "out_of_stock",
  message: "Only 2 left of Paneer Tikka. Lower the quantity.",
});
check("schedule", refusalFromItemError("order_items: Breakfast Thali is not available right now", "en")?.message, "Breakfast Thali isn't available right now.");
check("options", refusalFromItemError("order_items: choose a size (variant) for Pizza", "en")?.code, "invalid_options");
check("a real fault is not dressed up", refusalFromItemError("duplicate key value", "en"), null);

console.log("\n═══ Basket shape with options ═══");
check("plain line", areValidOrderLines([{ itemId: "e1", qty: 1 }]), true);
check("with a variant and add-ons", areValidOrderLines([{ itemId: "e1", qty: 1, variantId: "00000000-0000-0000-0000-000000000001", addonIds: ["00000000-0000-0000-0000-000000000002"] }]), true);
check("a non-string variant is refused", areValidOrderLines([{ itemId: "e1", qty: 1, variantId: 5 }]), false);
check("add-ons must be an array of strings", areValidOrderLines([{ itemId: "e1", qty: 1, addonIds: "x" }]), false);
check("at most 20 add-ons on a line", areValidOrderLines([{ itemId: "e1", qty: 1, addonIds: Array.from({ length: 21 }, (_, i) => `a${i}`) }]), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
