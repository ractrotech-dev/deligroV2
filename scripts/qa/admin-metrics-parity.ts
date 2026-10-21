/**
 * The admin dashboard's money figures, re-expressed through the shared ops
 * metrics (Phase 2, Task 2), checked against the formulas they replace.
 *
 * `legacy*` below are the loops admin-stats.ts, admin-series.ts and
 * admin-orders.ts ran before this change, copied verbatim in spirit. Where the
 * new figure agrees, the case asserts equality. Where it deliberately does not,
 * the case says which one the design's Money definitions call right and asserts
 * that one — those are the bugs this change fixes, written down.
 *
 * Usage: npx tsx scripts/qa/admin-metrics-parity.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { breakdownOrder, platformDeductions } from "../../src/lib/settlements/math";
import { adminDailyPoints, adminEarnings, adminPulse } from "../../src/lib/metrics/admin";
import type { MetricOrder, MetricRefund, PricingContext } from "../../src/lib/metrics/types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// 21 Oct 2026, 15:00 IST.
const NOW = new Date("2026-10-21T09:30:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const base: Omit<MetricOrder, "id" | "createdAt" | "total"> = {
  restaurantId: "r1",
  status: "delivered",
  deliveryFee: 30,
  taxAmount: 10,
  tip: 0,
  discount: 0,
  discountFundedBy: null,
  paymentMethod: "cod",
  paymentStatus: null,
};
const orders: MetricOrder[] = [
  { ...base, id: "today-1", createdAt: hoursAgo(2), total: 300 },
  { ...base, id: "today-2", createdAt: hoursAgo(5), total: 200, paymentMethod: "online", paymentStatus: "paid" },
  // 00:10 IST today and 23:50 IST yesterday: the IST midnight boundary.
  { ...base, id: "just-after-midnight", createdAt: "2026-10-20T18:40:00.000Z", total: 150 },
  { ...base, id: "just-before-midnight", createdAt: "2026-10-20T18:20:00.000Z", total: 120 },
  { ...base, id: "cancelled-today", createdAt: hoursAgo(1), total: 999, status: "cancelled" },
  // A discounted order (₹50 off, platform-funded) and a refunded online one.
  { ...base, id: "discounted", createdAt: hoursAgo(30), total: 450, discount: 50, discountFundedBy: "platform" },
  { ...base, id: "refunded", createdAt: hoursAgo(40), total: 500, paymentMethod: "online", paymentStatus: "refunded" },
  { ...base, id: "last-week", createdAt: hoursAgo(24 * 9), total: 400 },
  { ...base, id: "cancelled-last-week", createdAt: hoursAgo(24 * 10), total: 800, status: "cancelled" },
];
const refunds: MetricRefund[] = [{ id: "rf1", orderId: "refunded", amount: 200, status: "approved" }];
const pricing: PricingContext = {
  commissionPct: new Map([["r1", 20]]),
  otherCharges: new Map([["r1", 5]]),
  commissionGstPct: 18,
};

// ---- the formulas being replaced ----------------------------------------
const d7 = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
const d14 = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
const todayStart = "2026-10-20T18:30:00.000Z"; // IST midnight, 21 Oct

/** admin-stats.ts getAdminDashboard: non-cancelled rows, rolling 7/14-day windows. */
function legacyPulse(rows: MetricOrder[]) {
  let ordersToday = 0, gmvToday = 0, ordersCurr = 0, ordersPrev = 0, gmvCurr = 0, gmvPrev = 0;
  for (const o of rows.filter((r) => r.status !== "cancelled" && r.createdAt >= d14)) {
    if (o.createdAt >= d7) { ordersCurr++; gmvCurr += o.total; } else { ordersPrev++; gmvPrev += o.total; }
    if (o.createdAt >= todayStart) { ordersToday++; gmvToday += o.total; }
  }
  return { ordersToday, gmvToday, orders: { curr: ordersCurr, prev: ordersPrev }, gmv: { curr: gmvCurr, prev: gmvPrev } };
}

/** admin-orders.ts getPlatformEarnings: no discount, no payment method, no refunds. */
function legacyEarnings(rows: MetricOrder[]) {
  let today = 0, curr = 0, prev = 0;
  for (const o of rows.filter((r) => r.status !== "cancelled" && r.createdAt >= d14)) {
    const e = platformDeductions(breakdownOrder({
      total: o.total, deliveryFee: o.deliveryFee, taxAmount: o.taxAmount, tip: o.tip,
      commissionPct: 20, commissionGstPct: 18, otherCharges: 5,
      paymentMethod: null, paymentStatus: null, approvedRefunds: 0,
    }));
    if (o.createdAt >= d7) curr += e; else prev += e;
    if (o.createdAt >= todayStart) today += e;
  }
  return { today, curr, prev };
}

/** admin-series.ts getAdminSeries: every order counted, cancelled ones included. */
function legacyDaily(rows: MetricOrder[], days: string[]) {
  const istDay = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return days.map((day) => {
    const on = rows.filter((r) => istDay(r.createdAt) === day);
    return { date: day, orders: on.length, gmv: on.reduce((s, r) => s + r.total, 0) };
  });
}

// ---- parity ---------------------------------------------------------------
console.log("── today's pulse and the week-over-week trend ──");
const pulse = adminPulse(orders, NOW);
const lp = legacyPulse(orders);
ok("revenue today matches", pulse.gmvToday === lp.gmvToday, { new: pulse.gmvToday, old: lp.gmvToday });
ok("...and is 650: today's three non-cancelled orders, the 23:50-yesterday one excluded", pulse.gmvToday === 650);
ok("orders today match (non-cancelled, as the tile has always meant)", pulse.ordersToday === lp.ordersToday);
ok("this week's and last week's revenue match", pulse.gmv.curr === lp.gmv.curr && pulse.gmv.prev === lp.gmv.prev, { pulse, lp });
ok("this week's and last week's order counts match", pulse.orders.curr === lp.orders.curr && pulse.orders.prev === lp.orders.prev);

console.log("\n── platform earnings ──");
const earn = adminEarnings(orders, refunds, pricing, NOW);
const le = legacyEarnings(orders);
ok("today's earnings match where no discount or refund is involved", earn.today === le.today, { new: earn.today, old: le.today });
// The discounted order: settlement math takes commission on the food value the
// shop actually earned. The legacy loop priced it as if no discount existed.
// The refunded order: the refund came out of the shop's share, and the legacy
// loop ignored it. Settlement math is the design's definition, so the new
// figure must equal what a settlement for these orders would say.
const settlementSays = (ids: string[]) =>
  ids.reduce((s, id) => {
    const o = orders.find((x) => x.id === id)!;
    return s + platformDeductions(breakdownOrder({
      total: o.total, deliveryFee: o.deliveryFee, taxAmount: o.taxAmount, tip: o.tip,
      discount: o.discount, discountFundedBy: o.discountFundedBy === "platform" ? "platform" : "vendor",
      commissionPct: 20, commissionGstPct: 18, otherCharges: 5,
      paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
      approvedRefunds: refunds.filter((r) => r.orderId === id).reduce((a, r) => a + r.amount, 0),
    }));
  }, 0);
const weekIds = orders.filter((o) => o.status !== "cancelled" && o.createdAt >= d7).map((o) => o.id);
ok("this week's earnings equal what the settlement would deduct (discount and refund included)",
  earn.curr === settlementSays(weekIds), { new: earn.curr, settlement: settlementSays(weekIds), legacy: le.curr });

console.log("\n── the daily chart ──");
const days = ["2026-10-19", "2026-10-20", "2026-10-21"];
const points = adminDailyPoints(orders, { from: days[0], to: days[2] });
const ld = legacyDaily(orders, days);
ok("one point per IST day, oldest first", JSON.stringify(points.map((p) => p.date)) === JSON.stringify(days));
ok("the 23:50 order is yesterday's, the 00:10 order today's",
  points[1].gmv >= 120 && points[2].gmv === 650, points);
// The legacy chart added cancelled orders' totals to revenue — ₹999 on the 21st —
// while the "Revenue today" tile beside it excluded them. Cancelled orders are
// not sales (design, Money definitions); the chart now agrees with the tile.
ok("cancelled orders are no longer revenue on the chart", points[2].gmv === pulse.gmvToday && ld[2].gmv === pulse.gmvToday + 999);
ok("...nor counted as orders (so the AOV spark is sales ÷ sales orders)", points[2].orders === 3 && ld[2].orders === 4);
ok("the chart's total equals the sum of its points",
  points.reduce((s, p) => s + p.gmv, 0) === orders.filter((o) => o.status !== "cancelled" && o.createdAt >= "2026-10-18T18:30:00.000Z").reduce((s, o) => s + o.total, 0));

console.log("\n── the settlement report prices a refunded online order as the platform's money ──");
// platformHeldPayment (settlements/math.ts): a refunded online order was still
// collected by the platform; the refund is carried by approvedRefunds. The
// report used to map 'refunded' to null, pricing the order on the COD branch
// and charging the shop the whole food value a second time.
const reportsSrc = readFileSync(join(__dirname, "..", "..", "src/lib/data-access/admin-reports.ts"), "utf8");
ok("admin-reports passes the payment status through the shared mapper",
  !/o\.payment_status === "paid" \|\| o\.payment_status === "pending"\s*\?\s*o\.payment_status\s*:\s*null/.test(reportsSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
