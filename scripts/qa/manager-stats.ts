/**
 * QA — GET /api/manager/stats (Phase 2, Task 4).
 *
 * Offline: the period parser (presets, custom ranges and every way a custom
 * range can be wrong) and the payload's arithmetic for fixed orders.
 * Online (skips when no server): the route refuses an anonymous caller.
 *
 * Usage: npx tsx scripts/qa/manager-stats.ts   (BASE_URL for the online half)
 */
import { BASE_URL } from "./_env";
import { parseStatsQuery } from "../../src/lib/manager/stats-query";
import { statsPayload } from "../../src/lib/manager/stats-payload";
import type { MetricOrder } from "../../src/lib/metrics/types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// 21 Oct 2026, 15:00 IST.
const NOW = new Date("2026-10-21T09:30:00.000Z");
const q = (s: string) => parseStatsQuery(new URLSearchParams(s), NOW);

console.log("── periods ──");
let r = q("granularity=day");
ok("day is today, compared with yesterday", r.ok && r.range.from === "2026-10-21" && r.range.to === "2026-10-21" &&
  r.previous.from === "2026-10-20" && r.previous.to === "2026-10-20", r);
r = q("granularity=month");
ok("month runs from the 1st to today", r.ok && r.range.from === "2026-10-01" && r.range.to === "2026-10-21", r);
ok("...compared with the 21 days before it", r.ok && r.previous.from === "2026-09-10" && r.previous.to === "2026-09-30", r);
r = q("granularity=week");
ok("week runs from Monday", r.ok && r.range.from === "2026-10-19", r);
r = q("granularity=year");
ok("year runs from 1 January", r.ok && r.range.from === "2026-01-01", r);
r = q("");
ok("no granularity defaults to month", r.ok && r.granularity === "month");
r = q("granularity=custom&from=2026-10-01&to=2026-10-05");
ok("a custom range is taken as given", r.ok && r.range.from === "2026-10-01" && r.range.to === "2026-10-05" &&
  r.previous.to === "2026-09-30" && r.previous.from === "2026-09-26", r);
r = q("granularity=month&zone=11111111-1111-4111-8111-111111111111");
ok("the zone is carried", r.ok && r.zone === "11111111-1111-4111-8111-111111111111");

console.log("\n── refusals ──");
const err = (s: string) => { const x = q(s); return x.ok ? "ok" : x.error; };
ok("an end before the start", err("granularity=custom&from=2026-10-05&to=2026-10-01") === "range_reversed");
ok("more than a year", err("granularity=custom&from=2025-09-01&to=2026-10-05") === "range_too_long");
ok("a range ending tomorrow", err("granularity=custom&from=2026-10-20&to=2026-10-22") === "range_in_future");
ok("a date that is not a date", err("granularity=custom&from=2026-13-01&to=2026-10-05") === "bad_date");
ok("a custom range without dates", err("granularity=custom") === "bad_date");
ok("an unknown granularity", err("granularity=hour") === "bad_granularity");

console.log("\n── the payload ──");
const o = (id: string, r: string, createdAt: string, total: number, extra: Partial<MetricOrder> = {}): MetricOrder => ({
  id, restaurantId: r, zoneId: "z1", status: "delivered", createdAt, total, deliveryFee: 30, taxAmount: 0, tip: 0,
  discount: 0, discountFundedBy: null, paymentMethod: "cod", paymentStatus: null, items: [], ...extra,
});
const orders: MetricOrder[] = [
  o("a", "r1", "2026-10-21T05:00:00.000Z", 300, { items: [{ name: "Dal", qty: 2, price: 120, category: "Mains" }] }),
  o("b", "r2", "2026-10-20T18:20:00.000Z", 500, { zoneId: "z2" }), // 23:50 IST on the 20th
  o("c", "r1", "2026-10-20T18:40:00.000Z", 200), // 00:10 IST on the 21st
  o("d", "r2", "2026-10-02T10:00:00.000Z", 999, { status: "cancelled", cancelledBy: "vendor", cancellationReason: "Out of stock" }),
  o("prev", "r1", "2026-09-15T10:00:00.000Z", 400),
];
const parsed = q("granularity=month");
if (!parsed.ok) throw new Error("parse");
const p = statsPayload(orders, [], parsed, {
  now: NOW,
  canSeeFinance: true,
  vendorNames: new Map([["r1", "Spice Hub"], ["r2", "Tandoor, Bemetara"]]),
  vendorRatings: new Map([["r1", 4.4]]),
  zones: [{ id: "c1", name: "Bemetara", zones: [{ id: "z1", name: "Central" }, { id: "z2", name: "Station Road" }] }],
});
const seriesTotal = p.daily.reduce((s, d) => s + d.sales, 0);
ok("Σ daily sales = the period's sales", seriesTotal === p.growth.sales.current && seriesTotal === 1000, { seriesTotal, g: p.growth.sales });
ok("the 23:50 IST order is the 20th's, the 00:10 one the 21st's",
  p.daily.find((d) => d.date === "2026-10-20")?.sales === 500 && p.daily.find((d) => d.date === "2026-10-21")?.sales === 500);
ok("growth is against the previous 21 days", p.growth.sales.previous === 400);
ok("cancelled orders are not sales, and are counted with who and why",
  p.completedVsCancelled.cancelled.count === 1 && p.completedVsCancelled.byCancelledBy.vendor.count === 1 &&
  p.completedVsCancelled.topReasons[0]?.reason === "Out of stock");
ok("average order value with its own growth", p.averageOrderValue.current === Math.round(1000 / 3) && p.averageOrderValue.growth.previous === 400);
ok("best vendors by sales, named and rated", p.bestVendors[0].name === "Spice Hub" && p.bestVendors[0].rating === 4.4 &&
  p.bestVendors[1].name === "Tandoor, Bemetara" && p.bestVendors[1].rating === null);
ok("best categories", p.bestCategories[0]?.category === "Mains");
ok("zones named with their city", p.byZone.some((z) => z.zoneName === "Station Road" && z.cityName === "Bemetara" && z.sales === 500));
ok("the peak grid is 7 × 24", p.peakHours.grid.length === 7 && p.peakHours.grid.every((row) => row.length === 24));
ok("a month is drawn by day", p.bucketGranularity === "day" && p.buckets.length === 21);
const yearly = q("granularity=year");
if (!yearly.ok) throw new Error("parse");
const py = statsPayload(orders, [], yearly, { now: NOW, canSeeFinance: true, vendorNames: new Map(), vendorRatings: new Map(), zones: [] });
ok("a year is drawn by month", py.bucketGranularity === "month" && py.buckets.length === 10);
ok("the answer says when it was generated", p.generatedAt === NOW.toISOString());

console.log("\n── per city (§2.11) ──");
{
  const city = p.byCity.find((c) => c.cityName === "Bemetara");
  ok("zones roll up into a city subtotal", p.byCity.length === 1 && city !== undefined, p.byCity);
  const zoneSum = p.byZone.reduce((s, z) => ({ orders: s.orders + z.orders, sales: s.sales + z.sales, cancelled: s.cancelled + z.cancelled }), { orders: 0, sales: 0, cancelled: 0 });
  ok("the subtotal is the sum of its zones", city?.orders === zoneSum.orders && city?.sales === zoneSum.sales && city?.cancelled === zoneSum.cancelled, { city, zoneSum });
  ok("the city's AOV is its own sales ÷ orders", city?.averageOrderValue === Math.round(zoneSum.sales / zoneSum.orders), city);
}

console.log("\n── finance is absent without manager.finance.view (review finding 2) ──");
{
  const base = { now: NOW, vendorNames: new Map<string, string>(), vendorRatings: new Map<string, number>(), zones: [] };
  const hidden = statsPayload(orders, [], parsed, { ...base, canSeeFinance: false });
  const shown = statsPayload(orders, [], parsed, { ...base, canSeeFinance: true });
  const json = JSON.stringify(hidden);
  for (const key of ["deliveryFees", "discounts", "refunds", "netSales"]) {
    ok(`no "${key}" anywhere in the payload`, !json.includes(`"${key}"`));
  }
  ok("sales figures stay (orders, gross, customer paid, AOV, cancelled)",
    hidden.summary.orders === shown.summary.orders && hidden.summary.customerPaid === shown.summary.customerPaid &&
    hidden.summary.grossSales === shown.summary.grossSales && hidden.summary.cancelled.count === shown.summary.cancelled.count &&
    hidden.summary.averageOrderValue === shown.summary.averageOrderValue);
  ok("with the permission the finance figures are there",
    "deliveryFees" in shown.summary && "netSales" in shown.summary && shown.bestVendors.every((v) => "refunds" in v));
}

async function online() {
  console.log("\n── the route (online) ──");
  try {
    const res = await fetch(`${BASE_URL}/api/manager/stats?granularity=month`);
    ok("no session → 401", res.status === 401, res.status);
  } catch {
    console.log(`  (skipped: no server at ${BASE_URL})`);
  }
}

void online().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
