/**
 * QA — the Partner app's sales report and payments wording.
 *
 * The report's totals must agree with the dashboard and the payments screen
 * (lib/vendor/money.ts): the same sale, charges and earnings per order, cash
 * and online counted apart, cancelled orders out of the sales but listed.
 *
 * Runs offline. Usage: npx tsx scripts/qa/vendor-report.ts
 */
import { buildReport, parseReportFilters, parseReportRange } from "../../src/lib/vendor/report";

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

const sale = (id: string, status: string, s: number, method = "cod", disc = 0) => ({
  id,
  status,
  createdAt: "2026-10-10T08:00:00Z",
  total: s + 40,
  sale: s,
  vendorDiscount: disc,
  paymentMethod: method,
  paymentStatus: method === "online" ? "paid" : "pending",
});
const line = (orderId: string, net: number, paid: boolean, refund = 0) => ({
  orderId,
  commission: 30,
  commissionGst: 5,
  otherCharges: 5,
  vendorNet: net,
  refundRecovered: refund,
  paid,
});

const sales = [
  sale("a", "delivered", 300, "online", 20),
  sale("b", "delivered", 200, "cod"),
  sale("c", "cancelled", 150, "online"),
  sale("d", "kitchen", 100, "cod"),
  sale("e", "on_the_way", 120, "online"),
];
const ledger = [line("a", 260, true), line("b", 160, false, 10)];
const all = { status: "all", payment: "all", settled: "all" } as const;

console.log("\n═══ Rows ═══");
const r = buildReport(sales, ledger, all);
check("every order is a row", r.rows.length, 5);
check("delivered: charges from the ledger", r.rows[0].charges, 40);
check("delivered: earnings = net − refund recovered", r.rows[1].earnings, 150);
check("settled flag", [r.rows[0].settlement, r.rows[1].settlement], ["settled", "unsettled"]);
check("not delivered yet: no money columns", [r.rows[3].charges, r.rows[3].earnings, r.rows[3].settlement], [null, null, null]);
check("stages", r.rows.map((x) => x.stage), ["completed", "completed", "cancelled", "accepted", "completed"]);

console.log("\n═══ Totals ═══");
check("counts", [r.totals.orders, r.totals.completed, r.totals.cancelled, r.totals.inProgress], [5, 3, 1, 1]);
check("sales leave out the cancelled order", r.totals.sales, 300 + 200 + 100 + 120);
check("gross = sale + the shop's own discount", r.totals.grossSales, 720 + 20);
check("net = sale − refunds recovered", r.totals.netSales, 720 - 10);
check("refunds", r.totals.refunds, 10);
check("a row's gross / net", [r.rows[0].gross, r.rows[1].net], [320, 190]);
check("cancelled value listed apart", r.totals.cancelledValue, 150);
check("discounts", r.totals.vendorDiscounts, 20);
check("charges over priced orders", r.totals.charges, 80);
check("earnings", r.totals.earnings, 260 + 150);
check("settled vs unsettled", [r.totals.settled, r.totals.unsettled], [260, 150]);
check("cash vs online orders", [r.totals.codOrders, r.totals.onlineOrders], [2, 3]);

console.log("\n═══ Filters ═══");
check("completed only", buildReport(sales, ledger, { ...all, status: "completed" }).rows.map((x) => x.orderId), ["a", "b", "e"]);
check("cancelled only", buildReport(sales, ledger, { ...all, status: "cancelled" }).rows.map((x) => x.orderId), ["c"]);
check("in progress only", buildReport(sales, ledger, { ...all, status: "in_progress" }).rows.map((x) => x.orderId), ["d"]);
check("cash only", buildReport(sales, ledger, { ...all, payment: "cod" }).rows.map((x) => x.orderId), ["b", "d"]);
check("unsettled only", buildReport(sales, ledger, { ...all, settled: "unsettled" }).rows.map((x) => x.orderId), ["b"]);
check("query defaults", parseReportFilters(new URLSearchParams("")), all);
check("a known filter", parseReportFilters(new URLSearchParams("status=cancelled&payment=online"))?.status, "cancelled");
check("an unknown filter is refused", parseReportFilters(new URLSearchParams("status=lost")), null);

console.log("\n═══ Date range (IST) ═══");
const now = new Date("2026-10-21T06:00:00Z"); // 11:30 IST, 21 Oct
const def = parseReportRange(null, null, now);
check("default: this month so far", [def?.fromDay, def?.toDay], ["2026-10-01", "2026-10-21"]);
check("from = IST midnight", def?.from.toISOString(), "2026-09-30T18:30:00.000Z");
check("to = the IST midnight after the last day", def?.to.toISOString(), "2026-10-21T18:30:00.000Z");
check("one day", parseReportRange("2026-10-05", "2026-10-05", now)?.to.toISOString(), "2026-10-05T18:30:00.000Z");
check("reversed refused", parseReportRange("2026-10-10", "2026-10-01", now), null);
check("not a date refused", parseReportRange("2026-02-30", "2026-03-01", now), null);
check("starting in the future refused", parseReportRange("2026-11-01", "2026-11-02", now), null);
check("a year and a day is fine", parseReportRange("2025-10-21", "2026-10-21", now) !== null, true);
check("longer refused", parseReportRange("2025-10-19", "2026-10-21", now), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
