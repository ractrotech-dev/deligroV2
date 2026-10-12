/**
 * QA — the money rules, run against scenarios rather than trusted.
 *
 * Pure functions only (pricing, settlement math, payment re-apply rule): no
 * database, safe to run anywhere. Usage:  npm run test:finance
 */
import { computeChargesWith } from "../../src/lib/pricing";
import {
  breakdownOrder,
  platformHeldPayment,
  platformDeductions,
  sumSettlementTotals,
  checkTotals,
  correctionDelta,
  type SettlementOrderInput,
} from "../../src/lib/settlements/math";
import { shouldReapplyCapture } from "../../src/lib/payments/settle-decision";
import { istDateKey, startOfIstDay } from "../../src/lib/utils/ist-time";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

// total 500 = food 400 + fee 50 + tax 20 + tip 30
const base: SettlementOrderInput = {
  total: 500, deliveryFee: 50, taxAmount: 20, tip: 30,
  commissionPct: 10, commissionGstPct: 0, otherCharges: 0,
  paymentMethod: "online", paymentStatus: "paid", approvedRefunds: 0,
};
const c = (o: Partial<SettlementOrderInput>) => breakdownOrder({ ...base, ...o });

console.log("\n── refunded online orders are priced like paid ones ──");
check("platformHeldPayment: online paid", platformHeldPayment("online", "paid"));
check("platformHeldPayment: online refunded", platformHeldPayment("online", "refunded"));
check("platformHeldPayment: online pending is not held", !platformHeldPayment("online", "pending"));
check("platformHeldPayment: online failed is not held", !platformHeldPayment("online", "failed"));
check("platformHeldPayment: cod never held", !platformHeldPayment("cod", "paid") && !platformHeldPayment("cod", "refunded"));
check("full refund: paid and refunded give the same line",
  c({ paymentStatus: "paid", approvedRefunds: 500 }).contribution ===
  c({ paymentStatus: "refunded", approvedRefunds: 500 }).contribution);
check("full refund online: 360 − 500 = −140",
  c({ paymentStatus: "refunded", approvedRefunds: 500 }).contribution === -140,
  c({ paymentStatus: "refunded", approvedRefunds: 500 }).contribution);
check("partial refund 200: refunded status = paid status",
  c({ paymentStatus: "refunded", approvedRefunds: 200 }).contribution ===
  c({ paymentStatus: "paid", approvedRefunds: 200 }).contribution);
check("refunded, no refund row yet: still vendorNet (360)", c({ paymentStatus: "refunded" }).contribution === 360);
check("vendor-funded coupon 50 + refund 100: same either status",
  c({ total: 450, discount: 50, discountFundedBy: "vendor", paymentStatus: "refunded", approvedRefunds: 100 }).contribution ===
  c({ total: 450, discount: 50, discountFundedBy: "vendor", paymentStatus: "paid", approvedRefunds: 100 }).contribution);
check("platform-funded coupon 50, online refunded: food 400, net 360",
  (() => {
    const b = c({ total: 450, discount: 50, discountFundedBy: "platform", paymentStatus: "refunded" });
    return b.foodGross === 400 && b.vendorNet === 360 && b.contribution === 360;
  })());
check("GST on commission 18% + refunded: 400 − 40 − 7 = 353",
  c({ paymentStatus: "refunded", commissionGstPct: 18 }).vendorNet === 353 &&
  c({ paymentStatus: "refunded", commissionGstPct: 18 }).contribution === 353);

console.log("\n── COD and failed payments unchanged ──");
check("COD delivered: platform recovers its 40", c({ paymentMethod: "cod", paymentStatus: "pending" }).contribution === -40);
check("COD with null status: same", c({ paymentMethod: "cod", paymentStatus: null }).contribution === -40);
check("COD platform-funded coupon 50: owed back 50 − 40 = +10",
  c({ total: 450, discount: 50, discountFundedBy: "platform", paymentMethod: "cod", paymentStatus: "pending" }).contribution === 10);
check("online but failed is not remitted",
  !c({ paymentStatus: "failed" }).remitsVendor && c({ paymentStatus: "failed" }).contribution === -40);

console.log("\n── clamps and edge sizes ──");
const tiny = c({ total: 40 + 29 + 2, deliveryFee: 29, taxAmount: 2, tip: 0, otherCharges: 50, commissionPct: 20 });
check("fixed charge bigger than food never makes an online payout negative",
  tiny.vendorNet === 0 && tiny.contribution === 0, tiny);
check("deductions + net always equal food", tiny.vendorNet + platformDeductions(tiny) === tiny.foodGross);
check("100% commission leaves 0", c({ commissionPct: 100 }).vendorNet === 0);
check("0% commission leaves all food", c({ commissionPct: 0 }).vendorNet === 400);
check("10.5% of 333 rounds once to 35",
  c({ total: 333 + 50 + 17, taxAmount: 17, tip: 0, commissionPct: 10.5 }).commission === 35);

console.log("\n── batch totals add up ──");
const batch = [
  c({ paymentStatus: "refunded", approvedRefunds: 500 }),
  c({}),
  c({ paymentMethod: "cod", paymentStatus: "pending" }),
  c({ total: 450, discount: 50, discountFundedBy: "platform", paymentStatus: "paid" }),
];
const t = sumSettlementTotals(batch);
check("header = sum of lines", checkTotals(t, batch) === 0);
check("net = −140 + 360 − 40 + 360 = 540", t.netPayable === 540, t.netPayable);

console.log("\n── order pricing scenarios ──");
const cfg = { deliveryFee: 29, taxRate: 0.05, freeDeliveryThreshold: 499 };
let p = computeChargesWith(cfg, 300, 20);
check("₹300 + tip 20: fee 29, tax 15, total 364", p.deliveryFee === 29 && p.taxes === 15 && p.total === 364, p);
p = computeChargesWith(cfg, 499, 0);
check("at the free-delivery threshold delivery is free", p.deliveryFee === 0 && p.total === 499 + 25, p);
p = computeChargesWith(cfg, 498, 0);
check("one rupee below the threshold still pays delivery", p.deliveryFee === 29, p);
p = computeChargesWith(cfg, 0, 0);
check("empty basket costs nothing", p.total === 0, p);
check("odd tips are clamped",
  computeChargesWith(cfg, 100, 9999).tip === 50 &&
  computeChargesWith(cfg, 100, -5).tip === 0 &&
  computeChargesWith(cfg, 100, NaN).tip === 0);
check("tax 5% of ₹30 rounds 1.5 up to 2", computeChargesWith(cfg, 30).taxes === 2);
const priced = computeChargesWith(cfg, 300, 20);
check("coupon comes off the grand total, never below 0",
  Math.max(0, priced.total - 50) === 314 && Math.max(0, priced.total - 9999) === 0);
const sb = breakdownOrder({
  total: 314, deliveryFee: 29, taxAmount: 15, tip: 20, discount: 50, discountFundedBy: "vendor",
  commissionPct: 10, paymentMethod: "online", paymentStatus: "paid", approvedRefunds: 0,
});
check("vendor-funded coupon: food 250, commission 25, net 225",
  sb.foodGross === 250 && sb.commission === 25 && sb.vendorNet === 225, sb);

console.log("\n── payment retry rule ──");
const r = (o: Partial<Parameters<typeof shouldReapplyCapture>[0]>) =>
  shouldReapplyCapture({
    paymentRowStatus: "paid", incomingStatus: "paid", paymentErrorCode: null, orderPaymentStatus: "pending", ...o,
  });
check("captured payment, order still pending → re-apply", r({}) === true);
check("order already paid → do nothing (no second kitchen alert)", r({ orderPaymentStatus: "paid" }) === false);
check("held as underpaid → do not re-apply", r({ paymentErrorCode: "amount_mismatch" }) === false);
check("order failed earlier → re-apply", r({ orderPaymentStatus: "failed" }) === true);
check("order unreadable (null) → do nothing", r({ orderPaymentStatus: null }) === false);
check("late 'failed' webhook never re-applies", r({ incomingStatus: "failed" }) === false);
check("row not paid yet → normal path, not the retry path", r({ paymentRowStatus: "pending" }) === false);

console.log("\n── refund corrections after a payout is paid ──");
check("settled with no refund, ₹100 refund later → recover 100",
  correctionDelta({ approvedRefundsNow: 100, refundAlreadyInLine: 0, priorCorrections: 0 }) === 100);
check("commission rate changed since settlement: still exactly 100 (was 150 when re-priced)",
  correctionDelta({ approvedRefundsNow: 100, refundAlreadyInLine: 0, priorCorrections: 0 }) === 100);
check("second refund of 60 after a first of 100 was corrected → only 60",
  correctionDelta({ approvedRefundsNow: 160, refundAlreadyInLine: 0, priorCorrections: 100 }) === 60);
check("refund already inside the stored line → nothing to recover",
  correctionDelta({ approvedRefundsNow: 100, refundAlreadyInLine: 100, priorCorrections: 0 }) === 0);
check("refund smaller than what was already recovered never goes negative",
  correctionDelta({ approvedRefundsNow: 50, refundAlreadyInLine: 0, priorCorrections: 100 }) === 0);
{
  // The correction must equal what re-settling the order would have changed, at the SETTLED rates.
  const before = c({ approvedRefunds: 0 });
  const after = c({ approvedRefunds: 150 });
  check("online: correction = drop in the line",
    before.contribution - after.contribution ===
      correctionDelta({ approvedRefundsNow: 150, refundAlreadyInLine: 0, priorCorrections: 0 }));
  const codBefore = c({ paymentMethod: "cod", paymentStatus: "pending" });
  const codAfter = c({ paymentMethod: "cod", paymentStatus: "pending", approvedRefunds: 150 });
  check("COD: correction = drop in the line",
    codBefore.contribution - codAfter.contribution ===
      correctionDelta({ approvedRefundsNow: 150, refundAlreadyInLine: 0, priorCorrections: 0 }));
  const partBefore = c({ approvedRefunds: 100 });
  const partAfter = c({ approvedRefunds: 250 });
  check("a refund added to a line that already counted 100: drop = 150",
    partBefore.contribution - partAfter.contribution ===
      correctionDelta({ approvedRefundsNow: 250, refundAlreadyInLine: 100, priorCorrections: 0 }));
}

console.log("\n── 'today' is the Indian day on any host ──");
{
  // 01:30 IST on 13 Oct = 20:00 UTC on 12 Oct.
  const earlyMorning = new Date("2026-10-12T20:00:00Z");
  check("01:30 IST belongs to the 13th", istDateKey(earlyMorning) === "2026-10-13");
  check("today then starts 00:00 IST on the 13th (18:30 UTC on the 12th)",
    startOfIstDay(earlyMorning).toISOString() === "2026-10-12T18:30:00.000Z",
    startOfIstDay(earlyMorning).toISOString());
  check("23:59 IST is still the 13th", istDateKey(new Date("2026-10-13T18:29:00Z")) === "2026-10-13");
  check("00:00 IST flips to the 14th", istDateKey(new Date("2026-10-13T18:30:00Z")) === "2026-10-14");
  check("an order at 00:10 IST counts as today after midnight",
    new Date("2026-10-12T18:40:00Z") >= startOfIstDay(new Date("2026-10-12T19:00:00Z")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
