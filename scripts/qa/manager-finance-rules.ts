/**
 * QA — Phase 6 finance rules (pure): failed/delayed thresholds, settlement
 * delay by cycle, reconciliation states, online payment matching, cash day
 * status and rider ledger totals.
 *
 * Usage: npx tsx scripts/qa/manager-finance-rules.ts
 */
import {
  FINANCE_THRESHOLDS,
  cashDayStatus,
  classifyOnlinePayment,
  classifyOrderReconciliation,
  isSettlementDelayed,
  isStuckPayment,
  issueSeverity,
  riderLedgerTotals,
  stuckPaymentCounts,
  vendorDueNet,
} from "../../src/lib/ops/finance-rules";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail)}`}`);
  }
}
const NOW = new Date("2026-10-21T10:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

console.log("\n── thresholds ──");
check("thresholds are the pinned values", JSON.stringify(FINANCE_THRESHOLDS) === JSON.stringify({
  stuckPaymentMinutes: 30, refundUnsentHours: 24, settlementGraceDays: 3, cycleDays: { weekly: 7, monthly: 31 },
  draftStaleDays: 3, approvalOverdueHours: 48, riderPayoutDelayDays: 35,
}));
check("a payment pending 29 min is not stuck", !isStuckPayment(minutesAgo(29), NOW));
check("a payment pending 31 min is stuck", isStuckPayment(minutesAgo(31), NOW));

console.log("\n── settlement delay ──");
check("weekly, oldest unsettled 9 days → not delayed", !isSettlementDelayed("weekly", daysAgo(9), NOW));
check("weekly, oldest unsettled 11 days → delayed", isSettlementDelayed("weekly", daysAgo(11), NOW));
check("monthly, 33 days → not delayed", !isSettlementDelayed("monthly", daysAgo(33), NOW));
check("monthly, 35 days → delayed", isSettlementDelayed("monthly", daysAgo(35), NOW));
check("nothing unsettled → not delayed", !isSettlementDelayed("weekly", null, NOW));

console.log("\n── severity ──");
check("failed payment is critical", issueSeverity("failed_payment", 1) === "critical");
check("stuck payment is a warning", issueSeverity("stuck_payment", 2) === "warning");
check("settlement delayed past 2× its threshold is critical", issueSeverity("settlement_delayed", 24 * 21) === "critical");
check("settlement just delayed is a warning", issueSeverity("settlement_delayed", 24 * 11) === "warning");
check("approval overdue > 96 h is critical", issueSeverity("approval_overdue", 97) === "critical");
check("approval overdue 50 h is a warning", issueSeverity("approval_overdue", 50) === "warning");
check("rider payout delayed > 45 d is critical", issueSeverity("rider_payout_delayed", 24 * 46) === "critical");

console.log("\n── reconciliation ──");
const base = { delivered: true, deliveredAt: daysAgo(5), cycle: "weekly" as const, outstandingCorrection: 0, appliedCorrection: 0, now: NOW };
const paidLine = (contribution: number) => ({ settlementStatus: "paid" as const, contribution });
check("paid line 370, expected 370 → paid_matched",
  classifyOrderReconciliation({ ...base, line: paidLine(370), expectedContribution: 370 }).state === "paid_matched");
const corr = classifyOrderReconciliation({ ...base, line: paidLine(370), expectedContribution: 250, outstandingCorrection: 120 });
check("refund after payout with outstanding correction → correction_outstanding", corr.state === "correction_outstanding", corr);
const mm = classifyOrderReconciliation({ ...base, line: paidLine(370), expectedContribution: 250 });
check("no correction → paid_mismatch, difference −120", mm.state === "paid_mismatch" && mm.difference === -120, mm);
check("applied correction 120 → paid_matched",
  classifyOrderReconciliation({ ...base, line: paidLine(370), expectedContribution: 250, appliedCorrection: 120 }).state === "paid_matched");
check("draft line → in_draft",
  classifyOrderReconciliation({ ...base, line: { settlementStatus: "draft", contribution: 370 }, expectedContribution: 370 }).state === "in_draft");
check("no line, weekly, delivered 12 days ago → unsettled_due",
  classifyOrderReconciliation({ ...base, deliveredAt: daysAgo(12), line: null, expectedContribution: 370 }).state === "unsettled_due");
check("no line, delivered 2 days ago → unsettled_recent",
  classifyOrderReconciliation({ ...base, deliveredAt: daysAgo(2), line: null, expectedContribution: 370 }).state === "unsettled_recent");
check("unsettled difference is the expected contribution",
  classifyOrderReconciliation({ ...base, deliveredAt: daysAgo(12), line: null, expectedContribution: 370 }).difference === 370);

console.log("\n── online payments ──");
check("520 vs 52000 paise → matched", classifyOnlinePayment(520, 52000) === "matched");
check("520 vs 51900 paise → online_mismatch", classifyOnlinePayment(520, 51900) === "online_mismatch");
check("no payment row → missing_payment", classifyOnlinePayment(520, null) === "missing_payment");

console.log("\n── cash days ──");
check("2400 / 2400 → settled", cashDayStatus(2400, 2400, false) === "settled");
check("2400 / 2000 → pending", cashDayStatus(2400, 2000, false) === "pending");
check("a dispute wins", cashDayStatus(2400, 2400, true) === "disputed");
check("nothing collected, nothing deposited → settled", cashDayStatus(0, 0, false) === "settled");

console.log("\n── rider ledger ──");
const rows = [
  { type: "salary", amount: 12000, date: "2026-09-30", payoutId: "p1" },
  { type: "salary", amount: 12000, date: "2026-10-15", payoutId: null },
  { type: "bonus", amount: 500, date: "2026-10-10", payoutId: null },
  { type: "deduction", amount: 200, date: "2026-10-12", payoutId: null },
];
const all = riderLedgerTotals(rows);
check("unpaid = 12000 + 500 − 200 = 12300", all.unpaid === 12300, all);
check("oldest unpaid is 10 Oct", all.oldestUnpaidOn === "2026-10-10", all);
const oct = riderLedgerTotals(rows, { from: "2026-10-01", to: "2026-10-31" });
check("earned in October excludes September's row", oct.earnedInRange === 12300, oct);
const sep = riderLedgerTotals(rows, { from: "2026-09-01", to: "2026-09-30" });
check("earned in September is the paid salary only", sep.earnedInRange === 12000, sep);
check("ledger sums carry no float drift (10.10 + 20.20 = 30.30)",
  riderLedgerTotals([
    { type: "earning", amount: 10.1, date: "2026-10-01", payoutId: null },
    { type: "earning", amount: 20.2, date: "2026-10-02", payoutId: null },
  ]).unpaid === 30.3);

console.log("\n── dues net of outstanding corrections ──");
check("₹1000 owed, ₹200 correction outstanding → ₹800 payable", JSON.stringify(vendorDueNet(1000, 200)) === JSON.stringify({ payable: 800, recoverable: 0 }));
check("₹100 owed, ₹300 correction → nothing payable, ₹200 to recover", JSON.stringify(vendorDueNet(100, 300)) === JSON.stringify({ payable: 0, recoverable: 200 }));
check("vendor owes ₹50 and a ₹20 correction → ₹70 to recover", JSON.stringify(vendorDueNet(-50, 20)) === JSON.stringify({ payable: 0, recoverable: 70 }));

console.log("\n── stuck payments: an abandoned checkout is not a transaction ──");
check("pending payment, order still placed (customer walked away) → not stuck", stuckPaymentCounts("pending", "placed") === false);
check("authorized payment → stuck (money held, not captured)", stuckPaymentCounts("authorized", "placed") === true);
check("pending payment on an order the kitchen accepted → stuck", stuckPaymentCounts("pending", "kitchen") === true);
check("cancelled order → not stuck", stuckPaymentCounts("authorized", "cancelled") === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
