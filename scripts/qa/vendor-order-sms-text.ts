/**
 * The new-order text to a shop: dishes with quantity, the note when there is one.
 *
 * Usage: npm run test:vendor-sms
 */
import assert from "node:assert/strict";
import {
  DEFAULT_ORDER_SMS_TEMPLATE,
  fillOrderSms,
  orderDishes,
  orderInstructions,
  registeredShopNumber,
} from "../../src/lib/sms/order-sms-text";

let passed = 0;
let failed = 0;
function ok(name: string, run: () => void) {
  try {
    run();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}

const message = (lines: { name: string; qty: number }[], note: string | null) =>
  fillOrderSms(DEFAULT_ORDER_SMS_TEMPLATE, {
    order: "A1B2C3",
    dishes: orderDishes(lines),
    instructions: orderInstructions(note),
  });

ok("dishes carry their quantity", () =>
  assert.equal(orderDishes([{ name: "Paneer", qty: 2 }, { name: "Naan", qty: 1 }]), "2x Paneer, 1x Naan"));
ok("the note is in the message when there is one", () =>
  assert.match(message([{ name: "Paneer", qty: 2 }], "less spicy"), /2x Paneer\. Instructions: less spicy\. Open/));
ok("no note leaves no trace of one", () => {
  const text = message([{ name: "Paneer", qty: 2 }], "  ");
  assert.doesNotMatch(text, /Instructions|\{|\s{2}/);
});
ok("a long order says how many more", () => {
  const text = orderDishes(Array.from({ length: 12 }, (_, i) => ({ name: `Long dish name ${i}`, qty: 1 })));
  assert.ok(Array.from(text).length <= 100, text);
  assert.match(text, /\+\d+ more$/);
});
ok("one very long dish is still capped", () =>
  assert.ok(Array.from(orderDishes([{ name: "x".repeat(300), qty: 1 }])).length <= 100));
ok("a long note is capped", () => assert.ok(Array.from(orderInstructions("y".repeat(300))).length < 110));
ok("a link in a note is removed", () => {
  assert.equal(orderInstructions("visit https://evil.example/pay now"), " Instructions: visit now.");
  assert.equal(orderInstructions("www.evil.example"), "");
});
ok("a new line in a note is folded", () => assert.equal(orderInstructions("a\nb"), " Instructions: a b."));
ok("an order with no named dish still reads", () => assert.equal(orderDishes([]), "see the Partner app"));

ok("the owner's mobile comes first", () =>
  assert.equal(registeredShopNumber({ ownerMobile: "6260451258", ownerAccountPhone: "+919800000001" }), "+916260451258"));
ok("a shop with only an owner account phone still has a number", () =>
  assert.equal(registeredShopNumber({ ownerMobile: null, ownerAccountPhone: "+919800000001" }), "+919800000001"));
ok("the shop's own number is the last resort", () =>
  assert.equal(registeredShopNumber({ ownerMobile: " ", ownerAccountPhone: null, shopPhone: "9800000002" }), "+919800000002"));
ok("something that is not a number is skipped", () =>
  assert.equal(registeredShopNumber({ ownerMobile: "n/a", ownerAccountPhone: "9800000003" }), "+919800000003"));
ok("no number anywhere is no number", () => assert.equal(registeredShopNumber({}), null));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
