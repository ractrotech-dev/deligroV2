/**
 * QA — the ops metrics module (src/lib/metrics), run against fixed fixtures.
 *
 * Pure functions only: no database, safe to run anywhere. The point of the
 * module is that the manager dashboard, the statistics screens, finance and
 * every report compute one number one way (design §18.4), so the last block
 * asserts exactly that for a single set of rows.
 *
 * Usage:  npm run test:metrics
 */
import {
  approvedRefunds,
  averageOrderValue,
  bucketKey,
  cancelledSummary,
  completedVsCancelled,
  computeDashboard,
  computeStats,
  customerPaid,
  dailySeries,
  daysInRange,
  deliveryFees,
  discountsByFunder,
  grossSales,
  growth,
  istDayKey,
  istHourWeekday,
  netSales,
  orderRates,
  peakHours,
  platformCommission,
  presetRange,
  previousPeriod,
  rangeBounds,
  salesSummary,
  vendorEarnings,
  vendorPaymentsCompleted,
  bestVendors,
  bestCategories,
  zoneBreakdown,
  isCountedOrder,
  type MetricOrder,
  type MetricRefund,
  type PricingContext,
} from "../../src/lib/metrics";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

/** An order with sensible defaults: food 400 + fee 50 + tax 20 + tip 30 = 500. */
function order(o: Partial<MetricOrder> & { id: string; createdAt: string }): MetricOrder {
  return {
    restaurantId: "shop-a",
    zoneId: "zone-1",
    customerId: "cust-1",
    status: "delivered",
    total: 500,
    deliveryFee: 50,
    taxAmount: 20,
    tip: 30,
    discount: 0,
    discountFundedBy: null,
    paymentMethod: "online",
    paymentStatus: "paid",
    cancelledBy: null,
    cancellationReason: null,
    ...o,
  };
}

const pricing: PricingContext = {
  commissionPct: new Map([["shop-a", 10], ["shop-b", 20]]),
  otherCharges: new Map([["shop-b", 5]]),
  commissionGstPct: 18,
};

console.log("\n── IST days ──");
{
  // 23:50 IST on 20 Oct = 18:20 UTC on 20 Oct; 00:10 IST on 21 Oct = 18:40 UTC on 20 Oct.
  check("23:50 IST is the 20th", istDayKey("2026-10-20T18:20:00Z") === "2026-10-20");
  check("00:10 IST is the 21st", istDayKey("2026-10-20T18:40:00Z") === "2026-10-21");
  const b = rangeBounds({ from: "2026-10-21", to: "2026-10-21" });
  check("range starts 18:30 UTC the day before", b.start.toISOString() === "2026-10-20T18:30:00.000Z", b.start.toISOString());
  check("range end is exclusive next IST midnight", b.endExclusive.toISOString() === "2026-10-21T18:30:00.000Z", b.endExclusive.toISOString());
  check("daysInRange inclusive", daysInRange({ from: "2026-10-30", to: "2026-11-02" }).join() === "2026-10-30,2026-10-31,2026-11-01,2026-11-02");
  const prev = previousPeriod({ from: "2026-10-15", to: "2026-10-21" });
  check("previous equal period", prev.from === "2026-10-08" && prev.to === "2026-10-14", prev);
  check("week bucket = IST Monday", bucketKey("2026-10-21T10:00:00Z", "week") === "2026-10-19");
  check("week bucket at 00:10 IST Monday is that Monday", bucketKey("2026-10-18T18:40:00Z", "week") === "2026-10-19");
  check("month bucket", bucketKey("2026-10-31T19:00:00Z", "month") === "2026-11");
  check("year bucket", bucketKey("2026-12-31T19:00:00Z", "year") === "2027");
  const hw = istHourWeekday("2026-10-20T18:40:00Z"); // Wed 21 Oct 00:10 IST
  check("hour/weekday in IST", hw.hour === 0 && hw.weekday === 2, hw);
  const now = new Date("2026-10-21T06:00:00Z"); // Wed 21 Oct 11:30 IST
  check("preset day", JSON.stringify(presetRange("day", now)) === JSON.stringify({ from: "2026-10-21", to: "2026-10-21" }));
  check("preset week from Monday", presetRange("week", now).from === "2026-10-19");
  check("preset month from the 1st", presetRange("month", now).from === "2026-10-01");
  check("preset year from 1 Jan", presetRange("year", now).from === "2026-01-01");
}

console.log("\n── definitions ──");
const rows: MetricOrder[] = [
  // Delivered, online, platform-funded coupon 50 (customer paid 450).
  order({ id: "o1", createdAt: "2026-10-20T06:00:00Z", total: 450, discount: 50, discountFundedBy: "platform",
    items: [{ name: "Biryani", qty: 2, price: 200, category: "Biryani" }] }),
  // Delivered, COD, vendor-funded coupon 20 at shop-b.
  order({ id: "o2", createdAt: "2026-10-20T08:00:00Z", restaurantId: "shop-b", zoneId: "zone-2", total: 480,
    discount: 20, discountFundedBy: "vendor", paymentMethod: "cod", paymentStatus: "pending",
    items: [{ name: "Paneer", qty: 1, price: 300, category: "North Indian" }, { name: "Naan", qty: 4, price: 25, category: "Breads" }] }),
  // In flight (pending) — counts as a sale, not completed.
  order({ id: "o3", createdAt: "2026-10-21T05:00:00Z", status: "kitchen" }),
  // Cancelled by the vendor, refunded in full.
  order({ id: "o4", createdAt: "2026-10-21T05:30:00Z", status: "cancelled", cancelledBy: "vendor", cancellationReason: "Out of stock" }),
  // 23:50 IST on the 20th — belongs to the 20th.
  order({ id: "o5", createdAt: "2026-10-20T18:20:00Z", customerId: "cust-2" }),
];
const refunds: MetricRefund[] = [
  { id: "r1", orderId: "o1", amount: 100, status: "approved" },
  { id: "r1", orderId: "o1", amount: 100, status: "approved" }, // listed twice
  { id: "r2", orderId: "o4", amount: 500, status: "approved" }, // on a cancelled order
  { id: "r3", orderId: "o2", amount: 60, status: "pending" },   // not approved
  { id: "r4", orderId: "o-outside", amount: 999, status: "approved" }, // order not in the set
];

{
  check("gross sales = items subtotal of non-cancelled (400 + 400 + 400 + 400)", grossSales(rows) === 1600, grossSales(rows));
  check("customer paid excludes cancelled (450+480+500+500)", customerPaid(rows) === 1930, customerPaid(rows));
  const d = discountsByFunder(rows);
  check("discount split platform 50 / vendor 20", d.platform === 50 && d.vendor === 20 && d.total === 70, d);
  const r = approvedRefunds(rows, refunds);
  check("refund r1 counted once", r.total === 100, r);
  check("refund on cancelled order reported separately", r.onCancelled === 500, r);
  check("refund on an order outside the set is ignored", r.count === 1, r);
  check("net sales = gross − discounts − refunds (1600 − 70 − 100)", netSales(rows, refunds) === 1430, netSales(rows, refunds));
  const c = cancelledSummary(rows);
  check("cancelled separate: 1 order, ₹500", c.count === 1 && c.value === 500, c);
  check("delivery fees from non-cancelled", deliveryFees(rows) === 200);
  check("AOV = customer paid / non-cancelled orders", averageOrderValue(rows) === Math.round(1930 / 4));
  check("AOV with zero orders is 0", averageOrderValue([]) === 0);
  const rates = orderRates(rows);
  check("completion rate 3/5, cancellation 1/5", Math.abs(rates.completionRate - 0.6) < 1e-9 && Math.abs(rates.cancellationRate - 0.2) < 1e-9, rates);
  check("rates with no orders are 0", orderRates([]).completionRate === 0 && orderRates([]).cancellationRate === 0);
}

console.log("\n── growth ──");
{
  const g = growth(150, 100);
  check("growth +50%", g.pct === 50 && g.change === 50, g);
  const z = growth(80, 0);
  check("growth from zero has no percentage", z.pct === null && z.change === 80, z);
  const zz = growth(0, 0);
  check("growth 0 → 0 is 0%", zz.pct === 0, zz);
  const down = growth(50, 200);
  check("growth −75%", down.pct === -75, down);
}

console.log("\n── commission and vendor money ──");
{
  const pc = platformCommission(rows, refunds, pricing);
  // o1 shop-a: food 400 (450−50−20−30+50 platform) → 40, gst 7
  // o2 shop-b: food 480−50−20−30 = 380 → 76, gst 14, other 5
  // o3, o5 shop-a: food 400 → 40, gst 7 each
  check("commission summed per order", pc.commission === 196, pc);
  check("commission GST on commission", pc.commissionGst === 35, pc);
  check("other charges", pc.otherCharges === 5, pc);
  check("total = commission + gst + other", pc.total === 236, pc);

  const ve = vendorEarnings(rows, refunds, pricing, new Set(["o5"]));
  // completed, unpaid: o1 online → vendorNet 353 − refund 100 = 253; o2 COD → −(76+14+5) = −95.
  check("payable counts completed orders not in a paid settlement", ve.payable === 253, ve);
  check("COD vendor owing is recoverable, not payable", ve.recoverable === 95, ve);
  check("in-flight orders are not payable", !ve.byVendor.get("shop-a")?.orderIds.includes("o3"));
  check("paid orders are excluded", !ve.byVendor.get("shop-a")?.orderIds.includes("o5"));

  const done = vendorPaymentsCompleted(
    [
      { id: "s1", restaurantId: "shop-a", status: "paid", netPayable: 1000, paidAt: "2026-10-20T10:00:00Z" },
      { id: "s2", restaurantId: "shop-a", status: "draft", netPayable: 500, paidAt: null },
      { id: "s3", restaurantId: "shop-b", status: "void", netPayable: 700, paidAt: "2026-10-20T10:00:00Z" },
      { id: "s4", restaurantId: "shop-b", status: "paid", netPayable: 300, paidAt: "2026-09-01T10:00:00Z" },
    ],
    { from: "2026-10-01", to: "2026-10-31" }
  );
  check("payments completed = paid settlements in range", done.amount === 1000 && done.count === 1, done);
}

console.log("\n── statistics ──");
{
  const range = { from: "2026-10-20", to: "2026-10-21" };
  const series = dailySeries(rows, range);
  check("series zero-filled for every day", series.length === 2 && series[0].date === "2026-10-20");
  check("the 20th holds o1, o2 and the 23:50 order", series[0].orders === 3 && series[0].sales === 1430, series[0]);
  check("the 21st holds o3 as a sale and o4 as cancelled", series[1].orders === 1 && series[1].cancelled === 1 && series[1].sales === 500, series[1]);

  const cvc = completedVsCancelled(rows);
  check("completed vs cancelled", cvc.completed.count === 3 && cvc.cancelled.count === 1, cvc);
  check("cancelled by vendor", cvc.byCancelledBy.vendor.count === 1 && cvc.byCancelledBy.vendor.value === 500, cvc.byCancelledBy);
  check("top reason", cvc.topReasons[0]?.reason === "Out of stock" && cvc.topReasons[0]?.count === 1, cvc.topReasons);

  const ph = peakHours(rows);
  check("peak grid is 7 × 24", ph.grid.length === 7 && ph.grid.every((r) => r.length === 24));
  check("cancelled orders are not demand", ph.grid.flat().reduce((a, b) => a + b, 0) === 4);
  // o5 at 23:50 IST Tue 20 Oct → weekday 1, hour 23.
  check("23:50 IST lands in hour 23 of Tuesday", ph.grid[1][23] === 1, ph.grid[1]);

  const bv = bestVendors(rows, refunds, { names: new Map([["shop-a", "Spice Hub"]]) });
  check("best vendors ranked by sales", bv[0].restaurantId === "shop-a" && bv[0].name === "Spice Hub" && bv[0].sales === 1450, bv);
  const bc = bestCategories(rows);
  check("best categories from item lines", bc[0].category === "Biryani" && bc[0].sales === 400 && bc[0].qty === 2, bc);
  check("uncategorised lines are grouped, not dropped", bc.some((c) => c.category === "North Indian"));
  const zb = zoneBreakdown(rows);
  check("per-zone breakdown", zb.find((z) => z.zoneId === "zone-2")?.sales === 480 && zb.find((z) => z.zoneId === "zone-1")?.cancelled === 1, zb);
}

console.log("\n── dashboard = statistics = definitions (§18.4) ──");
{
  const now = new Date("2026-10-21T06:00:00Z"); // 21 Oct 11:30 IST
  const dash = computeDashboard(rows, {
    now,
    refunds,
    pricing,
    paidOrderIds: new Set(["o5"]),
    counts: {
      activeVendors: 2, onlineVendors: 1, activeRiders: 5, onlineRiders: 3, ridersOnDelivery: 1,
      riderPaymentsDue: 12000, pendingMarketingRequests: 2, pendingSupportTickets: 4,
    },
  });
  const keys = Object.keys(dash.figures);
  check("eighteen figures", keys.length === 18, keys);
  check("figures in the document's order", keys.join() === [
    "todaysTotalSales", "totalSales", "todaysOrders", "totalOrders", "pendingOrders", "completedOrders",
    "cancelledOrders", "activeVendors", "onlineVendors", "activeRiders", "onlineRiders", "ridersOnDelivery",
    "totalDeliveryFees", "totalPlatformCommission", "vendorPaymentsDue", "riderPaymentsDue",
    "pendingMarketingRequests", "pendingSupportTickets",
  ].join(), keys);
  check("today's sales = the 21st's non-cancelled", dash.figures.todaysTotalSales === 500);
  check("today's orders include the cancelled one", dash.figures.todaysOrders === 2);
  check("pending + completed + cancelled = total", dash.figures.pendingOrders + dash.figures.completedOrders + dash.figures.cancelledOrders === dash.figures.totalOrders);
  check("dashboard total sales == customerPaid", dash.figures.totalSales === customerPaid(rows));
  const stats = computeStats(rows, [], refunds, { from: "2026-10-20", to: "2026-10-21" });
  check("dashboard total sales == sum of the daily series", dash.figures.totalSales === stats.series.reduce((a, d) => a + d.sales, 0));
  check("stats summary == definitions summary", JSON.stringify(stats.summary) === JSON.stringify(salesSummary(rows, refunds)), stats.summary);
  check("dashboard commission == platformCommission total", dash.figures.totalPlatformCommission === platformCommission(rows, refunds, pricing).total);
  check("dashboard vendor dues == vendorEarnings payable", dash.figures.vendorPaymentsDue === vendorEarnings(rows, refunds, pricing, new Set(["o5"])).payable);
  check("dashboard delivery fees == deliveryFees", dash.figures.totalDeliveryFees === deliveryFees(rows));
  check("counts pass through", dash.figures.onlineRiders === 3 && dash.figures.pendingSupportTickets === 4);
  check("growth with no previous period has no percentage", stats.growth.sales.pct === null);
}

console.log("\n── Unpaid online checkouts are not orders ──");
{
  const at = "2026-10-21T06:00:00Z";
  const rows: MetricOrder[] = [
    order({ id: "c1", createdAt: at, paymentMethod: "cod", paymentStatus: "pending" }),
    order({ id: "c2", createdAt: at, status: "placed", paymentMethod: "online", paymentStatus: "pending" }),
    order({ id: "c3", createdAt: at, status: "placed", paymentMethod: "online", paymentStatus: "failed" }),
    order({ id: "c4", createdAt: at, status: "cancelled", paymentMethod: "online", paymentStatus: "failed" }),
    order({ id: "c5", createdAt: at, paymentMethod: "online", paymentStatus: "paid" }),
    order({ id: "c6", createdAt: at, status: "kitchen", paymentMethod: "online", paymentStatus: "authorized" }),
    order({ id: "c7", createdAt: at, paymentMethod: "online", paymentStatus: "refunded" }),
  ];
  const counted = rows.filter(isCountedOrder).map((o) => o.id);
  check("counted = COD + paid/authorized/refunded online", JSON.stringify(counted) === JSON.stringify(["c1", "c5", "c6", "c7"]), counted);
  check("customerPaid skips unpaid online", customerPaid(rows) === 2000, customerPaid(rows));
  check("cancelledSummary skips the never-paid cancelled checkout", cancelledSummary(rows).count === 0);
  check("orderRates over counted orders", orderRates(rows).completionRate === 3 / 4, orderRates(rows));
  const p10: PricingContext = { commissionPct: new Map([["shop-a", 10]]), otherCharges: new Map(), commissionGstPct: 0 };
  const dash = computeDashboard(rows, {
    now: new Date(at), refunds: [], pricing: p10, paidOrderIds: new Set(),
    counts: { activeVendors: 0, onlineVendors: 0, activeRiders: 0, onlineRiders: 0, ridersOnDelivery: 0, riderPaymentsDue: 0, pendingMarketingRequests: 0, pendingSupportTickets: 0 },
  });
  check("dashboard total orders = 4", dash.figures.totalOrders === 4, dash.figures);
  check("dashboard pending = 1 (the authorized kitchen order)", dash.figures.pendingOrders === 1, dash.figures);
  check("dashboard today's orders = 4", dash.figures.todaysOrders === 4);
  check("commission only on counted orders", dash.figures.totalPlatformCommission === 160, dash.figures.totalPlatformCommission);
  const stats = computeStats(rows, [], [], { from: "2026-10-21", to: "2026-10-21" });
  check("stats series orders = 4", stats.series[0].orders === 4, stats.series);
  check("peak grid counts 4", stats.peakHours.grid.flat().reduce((a, b) => a + b, 0) === 4);
  check("best vendors orders = 4", stats.bestVendors[0].orders === 4);
  check("zone breakdown orders = 4", stats.zones[0].orders === 4 && stats.zones[0].cancelled === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
