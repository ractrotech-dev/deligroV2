/**
 * QA — GET /api/manager/dashboard (Phase 2, Task 3).
 *
 * Offline: the payload's shape — the eighteen figures in the spec's order,
 * finance figures absent (not zero) without manager.finance.view, unavailable
 * figures null — and that the dashboard agrees with the statistics series for
 * the same rows (§18.4). Online (skips when no server): the route refuses an
 * anonymous caller.
 *
 * Usage: npx tsx scripts/qa/manager-dashboard.ts   (BASE_URL for the online half)
 */
import { BASE_URL } from "./_env";
import { computeDashboard } from "../../src/lib/metrics/dashboard";
import { dailySeries } from "../../src/lib/metrics/stats";
import { narrowScope } from "../../src/lib/auth/manager-scope";
import {
  dashboardPayload,
  FIGURE_ORDER,
  FINANCE_FIGURES,
} from "../../src/lib/manager/dashboard-payload";
import type { MetricOrder } from "../../src/lib/metrics/types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const NOW = new Date("2026-10-21T09:30:00.000Z");
const o = (id: string, createdAt: string, total: number, status: MetricOrder["status"] = "delivered"): MetricOrder => ({
  id, restaurantId: "r1", status, createdAt, total, deliveryFee: 30, taxAmount: 0, tip: 0, discount: 0,
  discountFundedBy: null, paymentMethod: "cod", paymentStatus: null,
});
const orders = [
  o("a", "2026-10-21T05:00:00.000Z", 300),
  o("b", "2026-10-21T06:00:00.000Z", 200, "placed"),
  o("c", "2026-10-20T10:00:00.000Z", 500),
  o("d", "2026-10-19T10:00:00.000Z", 999, "cancelled"),
];
const counts = {
  activeVendors: 4, onlineVendors: 3, activeRiders: 6, onlineRiders: 2, ridersOnDelivery: 1,
  riderPaymentsDue: 0, pendingMarketingRequests: 0, pendingSupportTickets: 0,
};
const pricing = { commissionPct: new Map([["r1", 20]]), otherCharges: new Map<string, number>(), commissionGstPct: 18 };
const dash = computeDashboard(orders, { now: NOW, refunds: [], pricing, paidOrderIds: new Set(), counts });

console.log("── the payload ──");
ok("eighteen figures, in the spec's order", FIGURE_ORDER.length === 18 &&
  FIGURE_ORDER[0] === "todaysTotalSales" && FIGURE_ORDER[11] === "ridersOnDelivery" && FIGURE_ORDER[17] === "pendingSupportTickets");
let p = dashboardPayload(dash, { canSeeFinance: true, unavailable: [], zone: null, now: NOW });
ok("with finance: all eighteen in order", JSON.stringify(p.order) === JSON.stringify(FIGURE_ORDER));
ok("...each with a number", FIGURE_ORDER.every((k) => typeof p.figures[k] === "number"));
ok("today's total sales is today's non-cancelled orders", p.figures.todaysTotalSales === 500);
ok("riders currently on delivery carries the count", p.figures.ridersOnDelivery === 1);
p = dashboardPayload(dash, { canSeeFinance: false, unavailable: [], zone: null, now: NOW });
ok("without finance: fourteen, in order", p.order.length === 14 &&
  JSON.stringify(p.order) === JSON.stringify(FIGURE_ORDER.filter((k) => !FINANCE_FIGURES.includes(k))));
ok("...and the four finance keys are absent, not zero", FINANCE_FIGURES.every((k) => !(k in p.figures)));
p = dashboardPayload(dash, { canSeeFinance: true, unavailable: ["pendingSupportTickets", "riderPaymentsDue"], zone: "z1", now: NOW });
ok("an unavailable figure is null and listed", p.figures.pendingSupportTickets === null && p.unavailable.includes("pendingSupportTickets"));
ok("...rider payments due too", p.figures.riderPaymentsDue === null && p.unavailable.includes("riderPaymentsDue"));
ok("the zone and the IST day are echoed", p.zone === "z1" && p.today === "2026-10-21");
p = dashboardPayload(dash, { canSeeFinance: false, unavailable: ["riderPaymentsDue"], zone: null, now: NOW });
ok("a finance figure that is unavailable and not permitted is simply absent",
  !("riderPaymentsDue" in p.figures) && !p.unavailable.includes("riderPaymentsDue"));

console.log("\n── the dashboard agrees with the statistics (§18.4) ──");
const series = dailySeries(orders, { from: "2026-10-19", to: "2026-10-21" });
ok("total sales = the sum of the daily series", dash.figures.totalSales === series.reduce((s, x) => s + x.sales, 0));
ok("pending + completed + cancelled = total orders",
  dash.figures.pendingOrders + dash.figures.completedOrders + dash.figures.cancelledOrders === dash.figures.totalOrders);

console.log("\n── a zone that is not the manager's ──");
const narrowed = narrowScope({ all: false, zoneIds: ["11111111-1111-4111-8111-111111111111"] }, "not-a-uuid");
ok("a malformed zone narrows to nothing, never to everything", !narrowed.all && narrowed.zoneIds.length === 0);
const empty = computeDashboard([], { now: NOW, refunds: [], pricing, paidOrderIds: new Set(), counts: { ...counts, activeVendors: 0, onlineVendors: 0, activeRiders: 0, onlineRiders: 0, ridersOnDelivery: 0 } });
ok("...and an empty scope is all zeros", Object.values(empty.figures).every((v) => v === 0));

async function online() {
  console.log("\n── the route (online) ──");
  try {
    const res = await fetch(`${BASE_URL}/api/manager/dashboard`);
    ok("no session → 401", res.status === 401, res.status);
  } catch {
    console.log(`  (skipped: no server at ${BASE_URL})`);
  }
}

void online().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
