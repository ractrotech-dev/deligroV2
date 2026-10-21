/**
 * QA — order placement with 0062: line prices with variants and add-ons (must
 * match the order-line guard), closed-shop messages, guard refusals → reasons,
 * and the basket shape check for the new fields.
 *
 * Runs offline. Usage: npx tsx scripts/qa/order-options.ts
 */
import { areValidOrderLines } from "../../src/lib/orders/validate-lines";
import {
  choiceLabel,
  choicePrice,
  choiceProblem,
  clockLabel,
  closedMessage,
  linePrice,
  lineKey,
  NO_CHOICE,
  offeredNow,
  refusalFromItemError,
} from "../../src/lib/orders/order-options";

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

console.log("\n═══ The customer's choice of size and add-ons ═══");
const biryani = {
  price: 260,
  discountPrice: 240,
  variants: [
    { id: "half", name: "Half", price: 160, available: true },
    { id: "full", name: "Full", price: 260, available: true },
    { id: "family", name: "Family", price: 480, available: false },
  ],
  addonGroups: [
    { id: "g1", name: "Raita", minSelect: 1, maxSelect: 1, addons: [{ id: "r1", name: "Boondi raita", price: 30, available: true }, { id: "r2", name: "Mint raita", price: 30, available: true }] },
    { id: "g2", name: "Extras", minSelect: 0, maxSelect: 2, addons: [{ id: "e1", name: "Egg", price: 20, available: true }, { id: "e2", name: "Salan", price: 15, available: true }, { id: "e3", name: "Gone", price: 5, available: false }] },
  ],
};
check("a size is required", choiceProblem(biryani, NO_CHOICE)?.code, "choose_size");
check("an unavailable size is refused", choiceProblem(biryani, { variantId: "family", addonIds: ["r1"] })?.code, "invalid_size");
check("a required group must be filled", choiceProblem(biryani, { variantId: "half", addonIds: [] }), { code: "group_min", group: "Raita", n: 1 });
check("a group's max holds", choiceProblem(biryani, { variantId: "half", addonIds: ["r1", "r2"] })?.code, "group_max");
check("an unavailable add-on is refused", choiceProblem(biryani, { variantId: "half", addonIds: ["r1", "e3"] })?.code, "invalid_addon");
check("another dish's add-on is refused", choiceProblem(biryani, { variantId: "half", addonIds: ["r1", "zz"] })?.code, "invalid_addon");
check("a good choice passes", choiceProblem(biryani, { variantId: "full", addonIds: ["r2", "e1", "e2"] }), null);
check("price: the size's price plus add-ons", choicePrice(biryani, { variantId: "full", addonIds: ["r2", "e1"] }), 310);
check("price: no size = the sale price", choicePrice({ price: 200, discountPrice: 180 }, NO_CHOICE), 180);
check("label: size · add-ons", choiceLabel(biryani, { variantId: "half", addonIds: ["r1", "e2"] }), "Half · Boondi raita, Salan");
check("label: nothing chosen is empty", choiceLabel(biryani, NO_CHOICE), "");
check("key: a plain dish is its id", lineKey("d1"), "d1");
check("key: add-on order doesn't matter", lineKey("d1", { variantId: "half", addonIds: ["b", "a"] }), lineKey("d1", { variantId: "half", addonIds: ["a", "b"] }));
check("key: two sizes are two lines", lineKey("d1", { variantId: "half", addonIds: [] }) === lineKey("d1", { variantId: "full", addonIds: [] }), false);

console.log("\n═══ Offered now (IST, same as the guard) ═══");
// 2026-10-21 is a Wednesday (3). 04:00 UTC = 09:30 IST.
const wed0930 = new Date("2026-10-21T04:00:00Z");
check("no schedule: always", offeredNow({}, wed0930), true);
check("breakfast 07:00–11:00 at 09:30", offeredNow({ availableFrom: "07:00", availableTo: "11:00" }, wed0930), true);
check("lunch 12:00–15:00 at 09:30", offeredNow({ availableFrom: "12:00", availableTo: "15:00" }, wed0930), false);
check("past midnight 22:00–02:00 at 01:00 IST", offeredNow({ availableFrom: "22:00", availableTo: "02:00" }, new Date("2026-10-20T19:30:00Z")), true);
check("past midnight 22:00–02:00 at 09:30", offeredNow({ availableFrom: "22:00", availableTo: "02:00" }, wed0930), false);
check("weekends only, on a Wednesday", offeredNow({ availableDays: [0, 6] }, wed0930), false);
check("Wednesdays, on a Wednesday", offeredNow({ availableDays: [3] }, wed0930), true);
check("the IST day, not the UTC one (Thu 00:30 IST is Wed in UTC)", offeredNow({ availableDays: [4] }, new Date("2026-10-21T19:00:00Z")), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
