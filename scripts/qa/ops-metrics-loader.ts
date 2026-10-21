/**
 * The scoped loader from Supabase rows to the ops metrics (Phase 2, Task 1).
 *
 * The mapper is exercised offline with raw rows shaped as PostgREST returns
 * them; the loader's scoping is checked structurally, because a service-role
 * read that forgets the zone filter compiles, runs, and quietly shows a
 * manager the whole city.
 *
 * Usage: npx tsx scripts/qa/ops-metrics-loader.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toMetricOrder } from "../../src/lib/data-access/ops-metrics-map";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

console.log("── rows onto metric orders ──");
const row = {
  id: "o1",
  restaurant_id: "r1",
  zone_id: "z1",
  customer_id: "c1",
  status: "delivered",
  created_at: "2026-10-20T18:20:00.000Z",
  total: "249.00",
  delivery_fee: "30",
  tax_amount: null,
  tip: "10",
  discount: "20",
  discount_funded_by: null,
  payment_method: "online",
  payment_status: "refunded",
  cancelled_by: null,
  cancellation_reason: null,
};
const items = [
  { order_id: "o1", name: "Dal", qty: 2, price: "90", menu_item_id: "m1", menu_items: { category: "Mains" } },
  { order_id: "o1", name: "Roti", qty: 4, price: 10, menu_item_id: null, menu_items: null },
];
let o = toMetricOrder(row, items);
ok("numerics arrive as numbers", o.total === 249 && o.deliveryFee === 30 && o.tip === 10 && o.discount === 20);
ok("a null tax is zero", o.taxAmount === 0);
ok("an unrecorded funder stays null (settlement math reads null as the vendor's)", o.discountFundedBy === null);
ok("a refunded payment status is passed through, not dropped", o.paymentStatus === "refunded");
ok("the zone is carried", o.zoneId === "z1");
ok("items carry their category", o.items?.[0].category === "Mains" && o.items?.[0].price === 90);
ok("an item without a menu row is uncategorised", o.items?.[1].category === null);
o = toMetricOrder({ ...row, discount_funded_by: "platform", payment_method: "upi", payment_status: "weird" });
ok("platform funding is kept", o.discountFundedBy === "platform");
ok("an unknown payment method or status is null", o.paymentMethod === null && o.paymentStatus === null);
ok("no items loaded means no items, not an empty order", o.items === undefined);
o = toMetricOrder({ ...row, status: "cancelled", cancelled_by: "vendor", cancellation_reason: "Out of stock" });
ok("cancellation provenance is carried", o.cancelledBy === "vendor" && o.cancellationReason === "Out of stock");

console.log("\n── every service-role read is zone-scoped ──");
const src = readFileSync(join(__dirname, "..", "..", "src/lib/data-access/ops-metrics.ts"), "utf8");
const fns = [...src.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
const bodyOf = (fn: string) => {
  const start = src.indexOf(`export async function ${fn}(`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};
for (const fn of fns) {
  const b = bodyOf(fn);
  if (!/from\("(orders|deliveries|restaurants|staff_zones|rider_status|vendor_settlement_orders)"\)/.test(b)) continue;
  // A read keyed by ids that came from an already-scoped read is scoped by
  // construction (loadPricing: the shops of the orders just loaded).
  const byScopedIds = /\.in\("id", chunk\)/.test(b) && !/from\("(orders|deliveries|staff_zones|rider_status)"\)/.test(b);
  ok(`${fn} applies the zone scope`, byScopedIds || /applyZoneScope\(|scopeZoneIds\(|scopedStaffIds\(/.test(b));
}
ok("there is a loader for orders, refunds, pricing, paid orders and counts",
  ["loadMetricOrders", "loadRefunds", "loadPricing", "loadPaidOrderIds", "loadDashboardCounts"].every((f) => fns.includes(f)));
ok("nothing selects *", !/select\("\*"\)/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
