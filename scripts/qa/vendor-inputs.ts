/**
 * QA — the Partner app's store and menu requests.
 *
 * Every store and menu write takes an untrusted JSON body. The checks are
 * pure functions (src/lib/vendor/{menu,store}-input.ts) so the rules a body
 * must meet are pinned here, not discovered from a database error.
 *
 * Runs offline. Usage: npx tsx scripts/qa/vendor-inputs.ts
 */
import { parseClock, parseMenuItemBody, parseMenuOptions } from "../../src/lib/vendor/menu-input";
import { parseHoliday, parseStoreUpdate } from "../../src/lib/vendor/store-input";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${e}, got ${a}`);
  }
}

const err = (r: unknown) => (r && typeof r === "object" && "error" in r ? (r as { error: string }).error : null);
const dish = { name: "Paneer Tikka", price: 220, category: "Starters", veg: true };
const uuid = "0d3c7d4e-8a8f-4b7e-9a51-2c3b4d5e6f70";

console.log("\n═══ Clock times ═══");
check("09:30 → 09:30", parseClock("09:30"), "09:30");
check("seconds are dropped", parseClock("23:05:59"), "23:05");
check("24:00 is refused", parseClock("24:00"), null);
check("9:30 (one digit) is refused", parseClock("9:30"), null);
check("a number is refused", parseClock(930), null);

console.log("\n═══ New dish ═══");
check("a complete dish passes", parseMenuItemBody(dish, false), dish);
check("name is required", err(parseMenuItemBody({ ...dish, name: "  " }, false)), "name_required");
check("price must be whole rupees", err(parseMenuItemBody({ ...dish, price: 99.5 }, false)), "invalid_price");
check("negative price refused", err(parseMenuItemBody({ ...dish, price: -1 }, false)), "invalid_price");
check("price as a string refused", err(parseMenuItemBody({ ...dish, price: "220" }, false)), "invalid_price");
check("veg must be said", err(parseMenuItemBody({ name: "X", price: 1, category: "" }, false)), "invalid_veg");
check("empty category becomes Popular", (parseMenuItemBody({ ...dish, category: "" }, false) as { category: string }).category, "Popular");
check("an http image is refused", err(parseMenuItemBody({ ...dish, imageUrl: "http://x/y.png" }, false)), "invalid_image");
check("null image clears it", (parseMenuItemBody({ ...dish, imageUrl: null }, false) as { imageUrl: string }).imageUrl, "");
check("a body that isn't an object", err(parseMenuItemBody([dish], false)), "bad_request");
check("from without to on create is refused", err(parseMenuItemBody({ ...dish, availableFrom: "11:00" }, false)), "invalid_schedule");

console.log("\n═══ Edit (partial) ═══");
check("only the fields sent come back", parseMenuItemBody({ price: 250 }, true), { price: 250 });
check("an empty edit is empty", parseMenuItemBody({}, true), {});
check("stock 0 is allowed (sold out by stock)", parseMenuItemBody({ stockQty: 0 }, true), { stockQty: 0 });
check("stock null stops tracking", parseMenuItemBody({ stockQty: null }, true), { stockQty: null });
check("negative stock refused", err(parseMenuItemBody({ stockQty: -3 }, true)), "invalid_stockQty");
check("days are sorted and de-duplicated", parseMenuItemBody({ availableDays: [5, 1, 5] }, true), { availableDays: [1, 5] });
check("all seven days means every day (null)", parseMenuItemBody({ availableDays: [0, 1, 2, 3, 4, 5, 6] }, true), { availableDays: null });
check("day 7 is refused", err(parseMenuItemBody({ availableDays: [7] }, true)), "invalid_days");
check("a bad time is refused", err(parseMenuItemBody({ availableFrom: "25:00" }, true)), "invalid_availableFrom");
check("times normalise", parseMenuItemBody({ availableFrom: "07:00:00", availableTo: "11:30" }, true), { availableFrom: "07:00", availableTo: "11:30" });
check("available must be boolean", err(parseMenuItemBody({ available: "yes" }, true)), "invalid_available");

console.log("\n═══ Variants and add-ons ═══");
const opts = {
  variants: [{ name: "Half", price: 150 }, { id: uuid, name: "Full", price: 260, available: false }],
  addonGroups: [{ name: "Extras", minSelect: 0, maxSelect: 2, addons: [{ name: "Cheese", price: 30 }, { name: "Mayo" }] }],
};
check("a full set parses", parseMenuOptions(opts), {
  variants: [{ name: "Half", price: 150, available: true }, { id: uuid, name: "Full", price: 260, available: false }],
  addonGroups: [{ name: "Extras", minSelect: 0, maxSelect: 2, addons: [{ name: "Cheese", price: 30, available: true }, { name: "Mayo", price: 0, available: true }] }],
});
check("an empty set clears", parseMenuOptions({}), { variants: [], addonGroups: [] });
check("a forged id is refused", err(parseMenuOptions({ variants: [{ id: "1 or 1=1", name: "X", price: 1 }] })), "invalid_variant");
check("variant price required", err(parseMenuOptions({ variants: [{ name: "X" }] })), "invalid_variant");
check("max below min refused", err(parseMenuOptions({ addonGroups: [{ name: "G", minSelect: 2, maxSelect: 1, addons: [{ name: "a" }, { name: "b" }] }] })), "invalid_group");
check("min above the add-ons on offer refused", err(parseMenuOptions({ addonGroups: [{ name: "G", minSelect: 3, maxSelect: 3, addons: [{ name: "a" }] }] })), "invalid_group");
check("a group with no add-ons refused", err(parseMenuOptions({ addonGroups: [{ name: "G", addons: [] }] })), "invalid_group");
check("21 variants refused", err(parseMenuOptions({ variants: Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, price: 1 })) })), "too_many_variants");
check("a 61-character name refused", err(parseMenuOptions({ variants: [{ name: "x".repeat(61), price: 1 }] })), "invalid_variant");

console.log("\n═══ Store ═══");
check("only sent fields come back", parseStoreUpdate({ tagline: " Best rolls " }), { tagline: "Best rolls" });
check("an empty tagline clears it", parseStoreUpdate({ tagline: "" }), { tagline: null });
check("hours go together", err(parseStoreUpdate({ openingTime: "09:00" })), "invalid_hours");
check("hours parse", parseStoreUpdate({ openingTime: "09:00", closingTime: "23:30" }), { openingTime: "09:00", closingTime: "23:30" });
check("past-midnight hours are allowed", parseStoreUpdate({ openingTime: "18:00", closingTime: "02:00" }), { openingTime: "18:00", closingTime: "02:00" });
check("equal hours refused", err(parseStoreUpdate({ openingTime: "09:00", closingTime: "09:00" })), "invalid_hours");
check("both null clears the hours", parseStoreUpdate({ openingTime: null, closingTime: null }), { openingTime: null, closingTime: null });
check("weekly off keeps week order", parseStoreUpdate({ weeklyOff: ["Tuesday", "Sunday"] }), { weeklyOff: ["Sunday", "Tuesday"] });
check("a made-up day refused", err(parseStoreUpdate({ weeklyOff: ["Funday"] })), "invalid_weekly_off");
check("closed every day refused", err(parseStoreUpdate({ weeklyOff: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] })), "invalid_weekly_off");
check("no delivery and no pickup refused", err(parseStoreUpdate({ deliveryAvailable: false, selfPickup: false })), "no_fulfilment");
check("a phone with letters refused", err(parseStoreUpdate({ shopPhone: "call me" })), "invalid_phone");
check("a phone parses", parseStoreUpdate({ shopPhone: "+91 98765 43210" }), { shopPhone: "+91 98765 43210" });
check("location needs all three", err(parseStoreUpdate({ lat: 26.1 })), "invalid_address");
check("lat out of range refused", err(parseStoreUpdate({ address: "A", lat: 91, lng: 80 })), "invalid_location");
check("prep 0 refused", err(parseStoreUpdate({ prepMinutes: 0 })), "invalid_prep_minutes");
check("prep null = platform default", parseStoreUpdate({ prepMinutes: null }), { prepMinutes: null });
check("a five-digit pincode refused", err(parseStoreUpdate({ pincode: "12345" })), "invalid_pincode");
check("nine cuisines refused", err(parseStoreUpdate({ cuisines: Array.from({ length: 9 }, (_, i) => `c${i}`) })), "invalid_cuisines");

console.log("\n═══ Holidays ═══");
check("a range parses", parseHoliday({ startsOn: "2026-11-01", endsOn: "2026-11-03", note: "Diwali" }), { startsOn: "2026-11-01", endsOn: "2026-11-03", note: "Diwali" });
check("one day is fine", parseHoliday({ startsOn: "2026-11-01", endsOn: "2026-11-01" }), { startsOn: "2026-11-01", endsOn: "2026-11-01", note: null });
check("end before start refused", err(parseHoliday({ startsOn: "2026-11-03", endsOn: "2026-11-01" })), "invalid_dates");
check("not a date refused", err(parseHoliday({ startsOn: "2026-13-40", endsOn: "2026-13-41" })), "invalid_dates");
check("a long note refused", err(parseHoliday({ startsOn: "2026-11-01", endsOn: "2026-11-01", note: "x".repeat(121) })), "invalid_note");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
