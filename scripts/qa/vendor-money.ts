/**
 * QA — the Partner app's money vocabulary.
 *
 * Dashboard, payments and reports all say "sales", "earnings", "payment due",
 * "paid / unpaid / partly paid". They must mean the same thing on every screen
 * and agree with the settlements Deligro actually pays (lib/settlements/math.ts),
 * so the definitions are pure functions, tested here on hand-checked orders.
 *
 * Runs offline. Usage: npx tsx scripts/qa/vendor-money.ts
 */
import { breakdownOrder, orderFoodValue } from "../../src/lib/settlements/math";
import { summariseLedger } from "../../src/lib/vendor/money";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ₹500 of food, ₹30 delivery, ₹25 tax, ₹10 tip, ₹50 off.
const base = { total: 515, deliveryFee: 30, taxAmount: 25, tip: 10, discount: 50 };

console.log("\n═══ Sale (food value) ═══");
check("a shop-funded discount comes off the shop's sale", orderFoodValue({ ...base, discountFundedBy: "vendor" }), 450);
check("a Deligro-funded discount does not", orderFoodValue({ ...base, discountFundedBy: "platform" }), 500);
check("no discount: total less fees, tax and tip", orderFoodValue({ total: 565, deliveryFee: 30, taxAmount: 25, tip: 10 }), 500);

console.log("\n═══ The direction of a payout ═══");
const terms = { commissionPct: 10, commissionGstPct: 18, otherCharges: 5, approvedRefunds: 0 };
const online = breakdownOrder({ ...base, discountFundedBy: "platform", ...terms, paymentMethod: "online", paymentStatus: "paid" });
const cod = breakdownOrder({ ...base, discountFundedBy: "platform", ...terms, paymentMethod: "cod", paymentStatus: "pending" });
// food 500 → commission 50, GST 9, other 5 → net 436
check("online: Deligro holds the money and owes the shop its net", online.contribution, 436);
check("COD: the shop holds the cash, owes the deductions, is owed the Deligro discount", cod.contribution, 50 - 64);

console.log("\n═══ The ledger summary ═══");
const line = (o: Partial<{ vendorNet: number; refundRecovered: number; contribution: number; paid: boolean; orderId: string }>) => ({
  orderId: o.orderId ?? "x",
  vendorNet: o.vendorNet ?? 0,
  refundRecovered: o.refundRecovered ?? 0,
  contribution: o.contribution ?? 0,
  paid: o.paid ?? false,
});
const s = summariseLedger(
  [
    line({ orderId: "a", vendorNet: 436, contribution: 436, paid: true }),
    line({ orderId: "b", vendorNet: 436, refundRecovered: 100, contribution: 336, paid: false }),
    line({ orderId: "c", vendorNet: 200, contribution: -30, paid: false }),
  ],
  { outstandingCorrections: 40, correctedOrderIds: new Set(["a"]) }
);
check("total earnings = Σ(net − refunds)", s.totalEarnings, 436 + 336 + 200);
check("paid orders", s.paidOrders, 1);
check("unpaid orders", s.unpaidOrders, 2);
check("a paid order with money being recovered is partly paid", s.partlyPaidOrders, 1);
check("payment due = Σ unpaid contributions − outstanding corrections", s.paymentDue, 336 - 30 - 40);
const empty = summariseLedger([], { outstandingCorrections: 0, correctedOrderIds: new Set() });
check("an empty ledger owes nothing", empty.paymentDue, 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
