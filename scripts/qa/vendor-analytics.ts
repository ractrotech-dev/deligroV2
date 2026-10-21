/**
 * QA — sales statistics (client requirements §2): windows, IST bucketing,
 * comparison with the previous period, best days, peak hours, best and slow
 * sellers. Runs offline. Usage: npx tsx scripts/qa/vendor-analytics.ts
 */
import {
  analyticsWindow,
  bucketKeys,
  computeAnalytics,
  istDay,
  type AnalyticsWindow,
} from "../../src/lib/vendor/analytics";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === "object" ? JSON.stringify(actual) : actual;
  const e = typeof expected === "object" ? JSON.stringify(expected) : expected;
  if (Object.is(a, e)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${String(e)}, got ${String(a)}`);
  }
}

// Wed 21 Oct 2026, 15:00 IST.
const NOW = new Date("2026-10-21T09:30:00Z");

console.log("\n═══ IST days ═══");
check("23:30 IST is still that day", istDay(new Date("2026-10-21T18:00:00Z")), "2026-10-21");
check("00:30 IST is the next day", istDay(new Date("2026-10-21T19:00:00Z")), "2026-10-22");

console.log("\n═══ Windows ═══");
const day = analyticsWindow("day", NOW) as AnalyticsWindow;
check("day: the last 7 days", [day.from, day.to], ["2026-10-15", "2026-10-21"]);
check("day: compared with the 7 before", [day.prevFrom, day.prevTo], ["2026-10-08", "2026-10-14"]);
check("day: 7 buckets", bucketKeys(day).length, 7);
const week = analyticsWindow("week", NOW) as AnalyticsWindow;
check("week: starts on a Monday", new Date(`${week.from}T00:00:00Z`).getUTCDay(), 1);
check("week: 8 weekly buckets", bucketKeys(week).length, 8);
const month = analyticsWindow("month", NOW) as AnalyticsWindow;
check("month: 12 monthly buckets from Nov last year", [bucketKeys(month).length, month.from], [12, "2025-11-01"]);
const year = analyticsWindow("year", NOW) as AnalyticsWindow;
check("year: 3 yearly buckets", bucketKeys(year), ["2024-01-01", "2025-01-01", "2026-01-01"]);
const custom = analyticsWindow("custom", NOW, { from: "2026-10-01", to: "2026-10-10" }) as AnalyticsWindow;
check("custom: by day, previous 10 days", [custom.unit, custom.prevFrom, custom.prevTo], ["day", "2026-09-21", "2026-09-30"]);
const long = analyticsWindow("custom", NOW, { from: "2026-01-01", to: "2026-10-21" }) as AnalyticsWindow;
check("custom over 62 days: by month", long.unit, "month");
check("custom with to before from is refused", analyticsWindow("custom", NOW, { from: "2026-10-10", to: "2026-10-01" }), { error: "invalid_range" });
check("custom in the future is refused", analyticsWindow("custom", NOW, { from: "2026-10-20", to: "2026-10-30" }), { error: "invalid_range" });
check("custom over a year is refused", analyticsWindow("custom", NOW, { from: "2025-01-01", to: "2026-10-21" }), { error: "range_too_long" });
check("a garbage date is refused", analyticsWindow("custom", NOW, { from: "2026-13-01", to: "2026-10-21" }), { error: "invalid_range" });
check("an unknown granularity is refused", analyticsWindow("hour", NOW), { error: "invalid_granularity" });

console.log("\n═══ Figures ═══");
const at = (day: string, istHour: number) => new Date(Date.parse(`${day}T00:00:00Z`) - 5.5 * 3600e3 + istHour * 3600e3).toISOString();
const orders = [
  { id: "o1", createdAt: at("2026-10-20", 19), sale: 400 },
  { id: "o2", createdAt: at("2026-10-20", 20), sale: 600 },
  { id: "o3", createdAt: at("2026-10-21", 13), sale: 200 },
  { id: "p1", createdAt: at("2026-10-10", 19), sale: 500 }, // previous period
];
const lines = [
  { orderId: "o1", menuItemId: "m1", name: "Paneer Tikka", qty: 2, price: 180 },
  { orderId: "o2", menuItemId: "m1", name: "Paneer Tikka", qty: 1, price: 180 },
  { orderId: "o2", menuItemId: "m2", name: "Naan", qty: 4, price: 40 },
  { orderId: "o3", menuItemId: "m3", name: "Cold Coffee", qty: 1, price: 90 },
  { orderId: "p1", menuItemId: "m4", name: "Lassi", qty: 9, price: 60 }, // outside the window
];
const menu = [
  { id: "m1", name: "Paneer Tikka" },
  { id: "m2", name: "Naan" },
  { id: "m3", name: "Cold Coffee" },
  { id: "m4", name: "Lassi" },
  { id: "m5", name: "Kulfi" },
];
const a = computeAnalytics(day, orders, lines, menu);
check("total sales in the window", a.totals.sales, 1200);
check("orders in the window", a.totals.orders, 3);
check("average order value", a.totals.averageOrderValue, 400);
check("previous period", [a.totals.prevSales, a.totals.prevOrders], [500, 1]);
check("sales change vs previous", a.totals.salesChange, 140);
check("a day with sales lands in its bucket", a.buckets.find((b) => b.start === "2026-10-20")?.sales, 1000);
check("best day first", a.bestDays[0], { day: "2026-10-20", sales: 1000, orders: 2 });
check("peak two hours", a.peak, { fromHour: 19, toHour: 21, sales: 1000 });
check("best seller by quantity", a.bestSellers[0], { menuItemId: "m2", name: "Naan", qty: 4, revenue: 160 });
check("slow movers start with unsold dishes", a.slowMovers.slice(0, 2).map((s) => s.name), ["Kulfi", "Lassi"]);
const none = computeAnalytics(day, [], [], []);
check("no previous sales → no % change, not infinity", none.totals.salesChange, null);
check("no sales → no peak", none.peak, null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
