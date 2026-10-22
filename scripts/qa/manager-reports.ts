/**
 * QA — the report registry (§13): kinds, filters and columns exactly as
 * pinned; permissions; finance columns dropped without finance.view; the pure
 * builders' totals (rates from summed parts, minutes weighted, empty ranges
 * give zeros never NaN); parity — the sales, commission and finance-daily
 * reports' totals equal the Finance overview's figures from the same rollup
 * (and the rollup itself equals the metrics module: manager-finance-sql-parity);
 * query validation; and structure (routes gate on reports.view + the kind's
 * permission; the admin page runs the same registry).
 *
 * Usage: npx tsx scripts/qa/manager-reports.ts
 */
import { readFileSync } from "node:fs";
import { REPORTS, resolveKind, permittedKinds, visibleColumns, reportMeta } from "../../src/lib/reports/definitions";
import {
  buildSales, buildCommission, buildFinanceDaily, buildVendorPerformance, buildRiderPerformance, buildCashReconciliation, buildMarketing,
  buildOrders, buildRefundsAdjustments,
} from "../../src/lib/reports/builders";
import { salesFromRollup, type FinanceRollup } from "../../src/lib/ops/finance-rollup";
import { parseReportQuery } from "../../src/lib/reports/query";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 600)}`}`); }
}
const NOW = new Date("2026-10-21T10:00:00.000Z");
const P = (q: string) => new URLSearchParams(q);

console.log("\n── registry ──");
const PINNED: Record<string, { filters: string[]; columns: string[] }> = {
  sales: { filters: ["vendor", "zone", "payment"], columns: ["date", "orders", "customerPaid", "grossSales", "discounts", "refunds", "netSales", "deliveryFees", "aov"] },
  orders: { filters: ["vendor", "rider", "status", "zone", "payment"], columns: ["code", "placedAt", "vendor", "rider", "status", "paymentMethod", "paymentStatus", "items", "total", "discount", "deliveryFee", "cancelledBy", "cancellationReason"] },
  "vendor-performance": { filters: ["vendor", "zone"], columns: ["vendor", "zone", "orders", "delivered", "cancelled", "cancellationRate", "rejectionRate", "avgAcceptMinutes", "avgPrepMinutes", "customerPaid", "netSales", "aov", "rating", "ratingCount", "commission", "payable"] },
  "rider-performance": { filters: ["rider", "zone"], columns: ["rider", "code", "delivered", "failed", "failedRate", "acceptanceRate", "avgDeliverMinutes", "onlineHours", "rating", "ratingCount", "codCollected"] },
  commission: { filters: ["vendor", "zone"], columns: ["vendor", "orders", "foodGross", "commission", "commissionGst", "otherCharges", "platformTotal", "vendorNet"] },
  "vendor-settlement": { filters: ["vendor", "status", "zone"], columns: ["vendor", "kind", "status", "periodStart", "periodEnd", "orders", "foodGross", "commission", "refundsRecovered", "netPayable", "paymentRef", "paidAt", "paidBy"] },
  "rider-payout": { filters: ["rider", "zone"], columns: ["rider", "code", "periodEnd", "amount", "method", "reference", "paidOn", "approvedBy", "requestedBy"] },
  cancellation: { filters: ["vendor", "zone", "status"], columns: ["code", "placedAt", "cancelledAt", "vendor", "cancelledBy", "reason", "value", "refunded"] },
  "refunds-adjustments": { filters: ["vendor", "zone", "status"], columns: ["date", "type", "orderCode", "vendor", "amount", "status", "origin", "reason", "settlementEffect", "decidedBy"] },
  marketing: { filters: ["vendor", "zone"], columns: ["campaign", "type", "vendor", "start", "end", "status", "budget", "fundedBy", "impressions", "clicks", "redemptions", "discountGiven", "attributedOrders", "attributedSales"] },
  "support-tickets": { filters: ["zone", "status"], columns: ["number", "createdAt", "requesterRole", "category", "priority", "status", "escalationLevel", "assignedTo", "firstResponseMinutes", "resolutionMinutes", "orderCode", "vendor"] },
  "cash-reconciliation": { filters: ["rider", "zone"], columns: ["date", "rider", "code", "codOrders", "collected", "deposited", "pending", "status"] },
  "finance-daily": { filters: ["vendor", "zone"], columns: ["date", "customerPaid", "grossSales", "discountsVendor", "discountsPlatform", "refunds", "netSales", "deliveryFees", "commission", "commissionGst", "vendorPaidOut", "riderPaidOut"] },
  "average-order": { filters: ["vendor", "zone", "payment"], columns: ["date", "orders", "aov"] },
};
check("exactly the 14 pinned kinds, in order", JSON.stringify(REPORTS.map((r) => r.kind)) === JSON.stringify(Object.keys(PINNED)));
for (const r of REPORTS) {
  check(`${r.kind}: filters and column keys as pinned`, JSON.stringify(r.filters) === JSON.stringify(PINNED[r.kind].filters)
    && JSON.stringify(r.columns.map((c) => c.key)) === JSON.stringify(PINNED[r.kind].columns), { filters: r.filters, cols: r.columns.map((c) => c.key) });
}
check("aliases: earnings → commission, settlement → vendor-settlement, x → null",
  resolveKind("earnings") === "commission" && resolveKind("settlement") === "vendor-settlement" && resolveKind("x") === null);
check("no Hindi in the registry (English only)", !/[ऀ-ॿ]/.test(JSON.stringify(REPORTS)));

console.log("\n── permissions ──");
const kinds = (p: Record<string, boolean>, admin = false) => permittedKinds(p, admin).map((d) => d.kind);
const reportsOnly = kinds({ "manager.reports.view": true });
check("reports.view only: no finance kinds and no cash reconciliation",
  ["commission", "vendor-settlement", "rider-payout", "refunds-adjustments", "finance-daily", "cash-reconciliation"].every((k) => !reportsOnly.includes(k as never)), reportsOnly);
check("with manager.cash: cash reconciliation appears", kinds({ "manager.reports.view": true, "manager.cash": true }).includes("cash-reconciliation"));
check("with finance.view: all 14", kinds({ "manager.reports.view": true, "manager.finance.view": true }).length === 14);
check("without reports.view: nothing, even with finance.view", kinds({ "manager.finance.view": true }).length === 0);
check("an admin runs all 14", kinds({}, true).length === 14);
const vp = visibleColumns(reportMeta("vendor-performance"), false).map((c) => c.key);
check("vendor-performance without finance: no commission/payable/netSales", !vp.includes("commission") && !vp.includes("payable") && !vp.includes("netSales"), vp);
const sales = visibleColumns(reportMeta("sales"), false).map((c) => c.key);
check("sales without finance keeps customerPaid/orders/aov, drops deliveryFees/refunds/netSales/discounts",
  sales.includes("customerPaid") && sales.includes("aov") && !sales.includes("deliveryFees") && !sales.includes("netSales") && !sales.includes("refunds") && !sales.includes("discounts"), sales);

console.log("\n── parity: report totals = Finance overview (same rollup) ──");
const rollup: FinanceRollup = {
  summary: { orders: 5, delivered: 4, grossSales: 2400, customerPaid: 2600, discountVendor: 50, discountPlatform: 70, refundsTotal: 120,
    refundsCount: 1, refundsOnCancelled: 40, cancelledCount: 1, cancelledValue: 300, deliveryFees: 100, commission: 300, commissionGst: 54,
    otherCharges: 10, foodGross: 2300, vendorNet: 1936 },
  byDay: [
    { date: "2026-10-20", orders: 3, customerPaid: 1500, grossSales: 1400, discountVendor: 50, discountPlatform: 0, refunds: 120, deliveryFees: 60,
      commission: 180, commissionGst: 32, otherCharges: 6, cancelledCount: 1, cancelledValue: 300 },
    { date: "2026-10-21", orders: 2, customerPaid: 1100, grossSales: 1000, discountVendor: 0, discountPlatform: 70, refunds: 0, deliveryFees: 40,
      commission: 120, commissionGst: 22, otherCharges: 4, cancelledCount: 0, cancelledValue: 0 },
  ],
  byVendor: [
    { restaurantId: "a", orders: 3, delivered: 3, cancelled: 1, customerPaid: 1500, grossSales: 1400, discounts: 50, refunds: 120, foodGross: 1300,
      commission: 180, commissionGst: 32, otherCharges: 6, vendorNet: 1082 },
    { restaurantId: "b", orders: 2, delivered: 1, cancelled: 0, customerPaid: 1100, grossSales: 1000, discounts: 70, refunds: 0, foodGross: 1000,
      commission: 120, commissionGst: 22, otherCharges: 4, vendorNet: 854 },
  ],
};
const range = { from: "2026-10-19", to: "2026-10-21" };
const overview = salesFromRollup(rollup.summary);
const s = buildSales(rollup, range);
check("sales totals: customerPaid / netSales / refunds = overview", s.totals!.customerPaid === overview.customerPaid && s.totals!.netSales === overview.netSales && s.totals!.refunds === overview.refunds.total, s.totals);
check("sales rows sum to the totals (net sales)", s.rows.reduce((a, r) => a + Number(r.netSales), 0) === overview.netSales);
check("sales: zero-filled day (19 Oct) and the cancelled-separate note", s.rows.length === 3 && s.rows[0].orders === 0 && s.notes.some((n) => /Cancelled orders are excluded/.test(n)));
const com = buildCommission(rollup, (id) => id.toUpperCase());
check("commission platformTotal total = overview platformCommission.total", com.totals!.platformTotal === overview.platformCommission.total, { com: com.totals, ov: overview.platformCommission });
const fd = buildFinanceDaily(rollup, range, { vendor: new Map([["2026-10-21", 900]]), rider: new Map([["2026-10-20", 12000.5]]) });
check("finance-daily: commission + GST totals = platform total", Number(fd.totals!.commission) + Number(fd.totals!.commissionGst) === overview.platformCommission.total);
check("finance-daily rows sum to its totals", fd.rows.reduce((a, r) => a + Number(r.netSales), 0) === fd.totals!.netSales && fd.totals!.vendorPaidOut === 900 && fd.totals!.riderPaidOut === 12000.5);

console.log("\n── builders' totals ──");
const vperf = buildVendorPerformance([
  { restaurantId: "a", vendor: "A", zoneId: null, orders: 4, delivered: 3, cancelled: 1, rejected: 1, acceptMinutesSum: 12, acceptCount: 3, prepMinutesSum: 45, prepCount: 3, rating: 4.2, ratingCount: 10 },
  { restaurantId: "b", vendor: "B", zoneId: null, orders: 2, delivered: 1, cancelled: 0, rejected: 0, acceptMinutesSum: 10, acceptCount: 1, prepMinutesSum: 20, prepCount: 1, rating: null, ratingCount: 0 },
], rollup, () => "Zone");
check("vendor cancellation rate total = 1/6 (from summed parts)", vperf.totals!.cancellationRate === 0.1667, vperf.totals);
check("vendor accept minutes total = 22/4 = 5.5 (weighted)", vperf.totals!.avgAcceptMinutes === 5.5);
check("private helper keys never reach a row", vperf.rows.every((r) => Object.keys(r).every((k) => !k.startsWith("_"))));
const rperf = buildRiderPerformance([
  { riderId: "1", rider: "R1", code: "DR-0001", delivered: 9, failed: 1, offers: 12, accepted: 10, deliverMinutesSum: 270, deliverCount: 9, onlineHours: 20.5, rating: 4.8, ratingCount: 5, codCollected: 3000 },
  { riderId: "2", rider: "R2", code: null, delivered: 0, failed: 0, offers: 0, accepted: 0, deliverMinutesSum: 0, deliverCount: 0, onlineHours: 0, rating: null, ratingCount: 0, codCollected: 0 },
]);
check("rider with no offers has a null acceptance rate (not NaN)", rperf.rows.find((r) => r.rider === "R2")!.acceptanceRate === null);
check("rider totals: acceptance 10/12, failed 1/10", rperf.totals!.acceptanceRate === 0.8333 && rperf.totals!.failedRate === 0.1, rperf.totals);
const cash = buildCashReconciliation([{ day: "2026-10-20", riderId: "1", codOrders: 3, collected: 2400, deposited: 2000, disputed: false }], () => ({ name: "R1", code: null }));
check("cash: pending 400, status pending", cash.rows[0].pending === 400 && cash.rows[0].status === "pending" && cash.totals!.pending === 400);
const mk = buildMarketing({ banners: [{ campaign: "Diwali", type: "banner", vendor: null, start: null, end: null, status: "active", fundedBy: "deligro", impressions: 10, clicks: 2, attributedOrders: 1 }],
  codes: [{ campaign: "FEST50", vendor: null, start: null, end: null, status: "active", fundedBy: "deligro", redemptions: 3, discountGiven: 75, attributedOrders: 3, attributedSales: 1500 }] });
check("marketing: budget is null until Phase 7; totals sum", mk.rows.every((r) => r.budget === null) && mk.totals!.attributedSales === 1500 && mk.totals!.impressions === 10);
const empty = buildSales({ summary: {} as FinanceRollup["summary"], byDay: [], byVendor: [] }, range);
check("an empty range gives zero rows of figures, totals 0, never NaN", empty.rows.length === 3 && Object.values(empty.totals!).every((v) => v === "Total" || v === 0), empty.totals);
const ord = buildOrders({ totalRows: 18420, totals: { orders: 18420, total: 1, discount: 0, deliveryFee: 0, items: 3 }, rows: [] });
check("SQL-paged builders keep the full row count (for too_large)", ord.totalRows === 18420 && ord.paged === true);
const ra = buildRefundsAdjustments({ totalRows: 2, totals: { refundsApproved: 160, refundsPending: 0, corrections: 120 }, rows: [] });
check("refunds-adjustments carries the counted-once note", ra.notes.some((n) => /Each refund appears once/.test(n)));

console.log("\n── query ──");
check("kind required", (() => { const r = parseReportQuery(P(""), NOW); return !r.ok && r.error === "bad_kind"; })());
check("a filter the kind does not take → bad_filter", (() => { const r = parseReportQuery(P("kind=sales&rider=11111111-1111-4111-8111-111111111111"), NOW); return !r.ok && r.error === "bad_filter"; })());
check("payment on a kind without it → bad_filter", (() => { const r = parseReportQuery(P("kind=commission&payment=cod"), NOW); return !r.ok && r.error === "bad_filter"; })());
check("a status outside the kind's options → bad_request", !parseReportQuery(P("kind=cancellation&status=delivered"), NOW).ok);
check("cancellation by vendor accepted", parseReportQuery(P("kind=cancellation&status=vendor"), NOW).ok);
check("pageSize over 200 → bad_request", !parseReportQuery(P("kind=orders&pageSize=500"), NOW).ok);
check("alias kind accepted", (() => { const r = parseReportQuery(P("kind=earnings"), NOW); return r.ok && r.kind === "commission"; })());
check("all=1 parsed", (() => { const r = parseReportQuery(P("kind=orders&all=1"), NOW); return r.ok && r.all; })());

console.log("\n── structure ──");
const route = readFileSync("src/app/api/manager/reports/route.ts", "utf8");
check("reports route needs manager.reports.view and the kind's permission", /managerApiContext\("manager\.reports\.view"\)/.test(route) && /mayRun\(def/.test(route));
check("reports route answers 413 too_large", /too_large/.test(route) && /413/.test(route));
check("kinds route lists only permitted kinds", /permittedKinds\(/.test(readFileSync("src/app/api/manager/reports/kinds/route.ts", "utf8")));
const registry = readFileSync("src/lib/reports/registry.ts", "utf8");
check("registry caps exports at MAX_EXPORT_ROWS", /built\.totalRows > MAX_EXPORT_ROWS/.test(registry));
check("registry money comes from the rollups (no inline order sums)", /ops_finance_rollup/.test(registry) && /ops_report_orders/.test(registry) && !/from\("orders"\)/.test(registry));
const admin = readFileSync("src/lib/data-access/admin-reports.ts", "utf8");
check("admin Reports runs the same registry (no duplicate arithmetic left)", /runReport\(/.test(admin) && !/breakdownOrder/.test(admin));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
