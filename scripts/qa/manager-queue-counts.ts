/**
 * Phase 3 review #9 and the tile/list rule: the order queues are counted from
 * the lean, scoped, uncapped `ops_order_queue_facts` rows (0142) — never a
 * 1,000-row embed that drops the oldest orders — and the Orders list leaves out
 * unpaid online checkouts exactly as the dashboard tiles do, so a tile's count
 * and the list it opens agree.
 *
 *   npx tsx scripts/qa/manager-queue-counts.ts
 */
import { readFileSync } from "node:fs";
import { computeDashboard } from "../../src/lib/metrics/dashboard";
import { isCountedOrder } from "../../src/lib/metrics/definitions";
import type { MetricOrder } from "../../src/lib/metrics/types";
import { COUNTED_ORDER_FILTER, factsFromQueueRow, queueCounts, queueOrderIds, type QueueFactRow } from "../../src/lib/ops/queue";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? `\n         ${detail}` : ""}`);
}

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const fact = (over: Partial<QueueFactRow> & { id: string }): QueueFactRow => ({
  status: "kitchen", created_at: ago(40), accepted_at: ago(35), ready_at: null, prep_minutes: 20, zone_id: "Z",
  eta_min: 60, eta_max: 75, shop_lat: 21.7, shop_lng: 81.5, drop_lat: 21.72, drop_lng: 81.52,
  delivery_status: null, driver_id: null, picked_up_at: null, failed_at: null, ...over,
});

console.log("\n── facts → live facts ──");
const f = factsFromQueueRow(fact({ id: "a", delivery_status: "assigned", driver_id: "r1" }));
check("statuses, stamps and the delivery carry over", f.id === "a" && f.status === "kitchen" && f.delivery?.driverId === "r1" && f.acceptedAt === ago(35));
check("shop → drop straight-line distance is computed", f.distanceKm !== null && f.distanceKm > 0 && f.distanceKm < 5);
check("no delivery row → no delivery", factsFromQueueRow(fact({ id: "b" })).delivery === null);

console.log("\n── counts and queues from facts ──");
const rows = [
  fact({ id: "old-unassigned", status: "ready", created_at: ago(90), accepted_at: ago(80), ready_at: ago(20) }),
  fact({ id: "fresh-kitchen", accepted_at: ago(5), created_at: ago(6) }),
  fact({ id: "late-accept", status: "placed", created_at: ago(12), accepted_at: null }),
  fact({ id: "slow-kitchen", accepted_at: ago(40), created_at: ago(41), delivery_status: "assigned", driver_id: "r1" }),
].map(factsFromQueueRow);
const counts = queueCounts(rows, NOW);
check("delayed counts every delayed order", counts.delayed === 3, JSON.stringify(counts));
check("unassigned counts only the riderless ones whose food is due", counts.unassigned === 1, JSON.stringify(counts));
check("the delayed queue is oldest first", JSON.stringify(queueOrderIds(rows, NOW, "delayed")) === JSON.stringify(["old-unassigned", "slow-kitchen", "late-accept"]),
  JSON.stringify(queueOrderIds(rows, NOW, "delayed")));
check("the unassigned queue", JSON.stringify(queueOrderIds(rows, NOW, "unassigned")) === JSON.stringify(["old-unassigned"]));
const many = Array.from({ length: 1500 }, (_, i) => fact({ id: `o${i}`, status: "ready", created_at: ago(200 - i / 10), accepted_at: ago(190), ready_at: ago(30) }));
check("1,500 in-flight orders are all counted (no cap dropping the oldest)", queueCounts(many.map(factsFromQueueRow), NOW).unassigned === 1500);

console.log("\n── tiles and lists agree ──");
check("the list's filter is built from the dashboard's own rule",
  COUNTED_ORDER_FILTER === "payment_method.neq.online,payment_status.in.(authorized,paid,refunded)", COUNTED_ORDER_FILTER);
const today = (h: number) => new Date(Date.UTC(2026, 9, 21, h - 5, 30)).toISOString();
const base = { restaurantId: "R", total: 300, deliveryFee: 30, taxAmount: 0, tip: 0, discount: 0, discountFundedBy: null };
const orders: MetricOrder[] = [
  { ...base, id: "cod", status: "placed", createdAt: today(10), paymentMethod: "cod", paymentStatus: "pending" } as MetricOrder,
  { ...base, id: "paid", status: "kitchen", createdAt: today(11), paymentMethod: "online", paymentStatus: "paid" } as MetricOrder,
  { ...base, id: "abandoned", status: "placed", createdAt: today(11), paymentMethod: "online", paymentStatus: "pending" } as MetricOrder,
  { ...base, id: "failed", status: "placed", createdAt: today(12), paymentMethod: "online", paymentStatus: "failed" } as MetricOrder,
];
const tile = computeDashboard(orders, {
  now: NOW, refunds: [], pricing: { commissionPct: new Map(), otherCharges: new Map(), commissionGstPct: 18 },
  paidOrderIds: new Set(), counts: {} as never,
}).figures;
const listed = orders.filter((o) => isCountedOrder(o));
check("Today's Orders tile == the list's today total", tile.todaysOrders === listed.length, `${tile.todaysOrders} vs ${listed.length}`);
check("Pending Orders tile == the list's pending total", tile.pendingOrders === listed.filter((o) => o.status !== "delivered" && o.status !== "cancelled").length);

console.log("\n── the reads use them ──");
const src = readFileSync("src/lib/data-access/manager-ops-orders.ts", "utf8");
check("queue counts come from ops_order_queue_facts", /ops_order_queue_facts/.test(src) && /queueCounts\(/.test(src));
check("no ACTIVE_CAP truncation remains", !/ACTIVE_CAP/.test(src));
check("every list read applies the counted-order filter", /COUNTED_ORDER_FILTER/.test(src));
const live = readFileSync("src/lib/data-access/manager-live.ts", "utf8");
check("recent failures are read within the scope's zones, newest first",
  /orders!inner\(zone_id\)/.test(live) && /order\("failed_at", \{ ascending: false \}\)/.test(live));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
