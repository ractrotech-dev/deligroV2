/**
 * Phase 3 contract check, server half: run the real serialisers on in-file
 * fixture rows and write what the routes would send to
 * `apps/manager/test/fixtures/api/generated/`. `apps/manager/test/contract_test.dart`
 * parses each file with the app's models and fails on any field the app reads
 * that is missing or mistyped.
 *
 *   npx tsx scripts/qa/manager-contract-emit.ts
 *   cd apps/manager && flutter test test/contract_test.dart
 *
 * Fixtures cover one order in each status, a cancelled order with its reason,
 * an order with no rider, a stale rider, a rider on a break, an ineligible
 * candidate, and the action route's success, re-read-failed and error answers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toOrderListItem, type OpsOrderRow } from "../../src/lib/ops/order-row";
import { mergeTimeline, toOrderDetail } from "../../src/lib/ops/order-detail";
import { encodeCursor } from "../../src/lib/ops/order-query";
import { buildLiveSnapshot, type LiveRows } from "../../src/lib/ops/live-snapshot";
import { rankCandidates } from "../../src/lib/ops/live-rules";
import { toRiderCandidate } from "../../src/lib/ops/rider-candidate";
import type { DbOrderStatus } from "../../src/lib/ops/order-contract";

const NOW = new Date("2026-10-21T08:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const agoS = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const uuid = (n: number) => `3f2c1a${String(n).padStart(2, "0")}-1111-4222-8333-${String(n).padStart(12, "0")}`;

const vendor = { id: uuid(90), name: "Spice Hub", lat: 21.7, lng: 81.5 };

function row(n: number, status: DbOrderStatus, over: Partial<OpsOrderRow> = {}): OpsOrderRow {
  const withRider = status === "ready" || status === "on_the_way" || status === "delivered";
  return {
    id: uuid(n),
    status,
    createdAt: ago(60 - n),
    acceptedAt: status === "placed" ? null : ago(58 - n),
    readyAt: ["ready", "on_the_way", "delivered"].includes(status) ? ago(30 - n) : null,
    prepMinutes: 20,
    zoneId: uuid(80),
    etaMin: 40,
    etaMax: 55,
    vendor,
    drop: { lat: 21.71, lng: 81.52 },
    customerName: n % 2 ? "Asha" : null,
    total: 300 + n * 10,
    itemCount: 2,
    payment: { method: n % 2 ? "cod" : "online", status: n % 2 ? "pending" : "paid" },
    byPhone: n === 3,
    delivery: withRider
      ? {
          status: status === "delivered" ? "delivered" : status === "on_the_way" ? "picked_up" : "assigned",
          driverId: uuid(70),
          pickedUpAt: status === "on_the_way" || status === "delivered" ? ago(10) : null,
          failedAt: null,
        }
      : null,
    riderName: withRider ? "Ravi" : null,
    riderCode: withRider ? "DR-0001" : null,
    ...over,
  };
}

const rows: OpsOrderRow[] = [
  row(1, "placed"),
  row(2, "kitchen"),
  row(3, "ready", { delivery: null, riderName: null, riderCode: null }), // ready, no rider
  row(4, "ready"),
  row(5, "on_the_way"),
  row(6, "delivered"),
  row(7, "cancelled", { cancelledBy: "vendor", cancellationReason: "Out of stock", cancelledAt: ago(45) }),
];

const ordersList = {
  items: rows.map((r) => toOrderListItem(r, NOW)),
  nextCursor: encodeCursor(rows[rows.length - 1].createdAt, rows[rows.length - 1].id),
  counts: { delayed: 1, unassigned: 1 },
};
const lastPage = { items: [toOrderListItem(rows[0], NOW)], nextCursor: null, counts: { delayed: 0, unassigned: 0 } };

const actors = new Map([
  ["m1", { id: "m1", name: "Mona", role: "manager" }],
  ["v1", { id: "v1", name: "Vik", role: "restaurant" }],
]);
const timeline = mergeTimeline(
  [
    { at: ago(55), kind: "status", from: null, to: "placed", actorId: null, reason: null },
    { at: ago(53), kind: "status", from: "placed", to: "kitchen", actorId: "v1", reason: null },
    { at: ago(25), kind: "status", from: "kitchen", to: "ready", actorId: "v1", reason: null },
  ],
  [
    { at: ago(24), kind: "accepted", driverId: uuid(70), actorId: null, reason: null, method: null },
    { at: ago(15), kind: "reassigned", driverId: uuid(71), actorId: "m1", reason: "Rider's bike broke down", method: null },
  ],
  [{ at: ago(20), authorId: "m1", body: "Called the kitchen" }],
  [
    { at: ago(18), action: "order.correct.status", actorId: "m1", reason: "Wrong tap", before: { status: "ready" }, after: { status: "kitchen" } },
    { at: ago(12), action: "order.escalate", actorId: "m1", reason: "Customer angry", before: { level: 0 }, after: { level: 1 } },
  ],
  actors
);

const detailExtras = {
  items: [
    { id: uuid(60), name: "Paneer Tikka", qty: 2, price: 180 },
    { id: uuid(61), name: "Butter Naan", qty: 4, price: 30 },
  ],
  money: { subtotal: 480, discount: 20, deliveryFee: 40, tax: 24, tip: 10, total: 534 },
  pickup: { name: "Spice Hub", address: "Station Road", lat: 21.7, lng: 81.5, phone: "+919800000000" },
  drop: { label: "Home", address: "12 Gandhi Nagar", landmark: "Near the temple", lat: 21.71, lng: 81.52, note: "Blue gate behind the temple" },
  customer: { name: "Asha", phone: "+919811111111" },
  delivery: {
    id: uuid(50),
    status: "assigned" as const,
    rider: { id: uuid(71), name: "Sunil", code: "DR-0002", phone: "+919800000002" },
    offeredTo: { id: uuid(70), name: "Ravi" },
    assignedAt: ago(15),
    pickedUpAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: null,
    lastFix: { lat: 21.705, lng: 81.51, at: agoS(40), ageSeconds: 40 },
  },
  timeline,
  tickets: [{ id: uuid(40), number: 1042, status: "escalated", priority: "high" }],
};
const allPerms = {
  "manager.move_status": true, "manager.assign_rider": true, "manager.reassign_rider": true,
  "manager.orders.escalate": true, "manager.orders.correct": true, "manager.call_customer": true,
};
const orderDetail = toOrderDetail(rows[3], detailExtras, allPerms, NOW);
const orderDetailNoPhone = toOrderDetail(
  rows[2],
  { ...detailExtras, delivery: null, tickets: [], timeline: [] },
  { "manager.move_status": true },
  NOW
);
const orderDetailCancelled = toOrderDetail(rows[6], { ...detailExtras, delivery: null }, allPerms, NOW);

const ctx = { orderZoneId: uuid(80), currentRiderId: uuid(71), shop: { lat: 21.7, lng: 81.5 } };
const fact = (n: number, over: Partial<Parameters<typeof toRiderCandidate>[1]> = {}) => ({
  id: uuid(n), isOnline: true, breakUntil: null, lastFixAt: agoS(30), lat: 21.702, lng: 81.503,
  zoneIds: [uuid(80)], suspended: false, activeDeliveries: 0, ...over,
});
const orderRiders = {
  riders: rankCandidates([
    toRiderCandidate({ name: "Ravi", code: "DR-0001" }, fact(70), ctx, NOW),
    toRiderCandidate({ name: "Sunil", code: "DR-0002" }, fact(71, { activeDeliveries: 1 }), ctx, NOW), // current rider
    toRiderCandidate({ name: "Kiran", code: null }, fact(72, { isOnline: false, lastFixAt: null, lat: null, lng: null }), ctx, NOW),
    toRiderCandidate({ name: "Deepa", code: "DR-0004" }, fact(73, { breakUntil: new Date(NOW.getTime() + 600_000).toISOString() }), ctx, NOW),
    toRiderCandidate({ name: " ", code: "DR-0005" }, fact(74, { zoneIds: [uuid(81)] }), ctx, NOW),
    toRiderCandidate({ name: "Old fix", code: null }, fact(75, { lastFixAt: ago(30) }), ctx, NOW),
  ]),
};

const liveRows: LiveRows = {
  orders: rows.filter((r) => ["placed", "kitchen", "ready", "on_the_way"].includes(r.status)),
  riders: [
    { id: uuid(70), name: "Ravi", code: "DR-0001", isOnline: true, breakUntil: null, lastFixAt: agoS(20), lat: 21.703, lng: 81.505,
      zoneIds: [uuid(80)], suspended: false, activeOrderIds: [uuid(4), uuid(5)], phone: "+919800000001" },
    { id: uuid(71), name: "Sunil", code: "DR-0002", isOnline: true, breakUntil: null, lastFixAt: agoS(15), lat: 21.7, lng: 81.5,
      zoneIds: [uuid(80)], suspended: false, activeOrderIds: [], phone: "+919800000002" },
    { id: uuid(72), name: "Gone quiet", code: null, isOnline: false, breakUntil: null, lastFixAt: ago(9), lat: 21.71, lng: 81.51,
      zoneIds: [uuid(80)], suspended: false, activeOrderIds: [uuid(5)], phone: null },
    { id: uuid(73), name: "Deepa", code: "DR-0004", isOnline: true, breakUntil: new Date(NOW.getTime() + 600_000).toISOString(),
      lastFixAt: agoS(50), lat: 21.69, lng: 81.49, zoneIds: [uuid(80)], suspended: false, activeOrderIds: [], phone: "+919800000004" },
    { id: uuid(74), name: "Visitor", code: "DR-0005", isOnline: true, breakUntil: null, lastFixAt: agoS(10), lat: 21.7, lng: 81.5,
      zoneIds: [uuid(81)], suspended: false, activeOrderIds: [], phone: "+919800000005" },
  ],
  failedRecently: [row(8, "cancelled", { delivery: { status: "failed", driverId: uuid(70), pickedUpAt: ago(40), failedAt: ago(20) } })],
  scopeZoneIds: [uuid(80)],
};
const live = buildLiveSnapshot(liveRows, NOW);

// The actions route's answers (POST /api/manager/orders/[id]/actions).
const actions = {
  ok: { ok: true, order: orderDetail },
  okEscalated: { ok: true, order: orderDetail, ticket: orderDetail.tickets[0] },
  okReReadFailed: { ok: true, order: null },
  conflict: { error: "status_changed", current: "ready" },
  badField: { error: "bad_request", field: "reason" },
  failed: { error: "action_failed" },
};

const out = join("apps", "manager", "test", "fixtures", "api", "generated");
mkdirSync(out, { recursive: true });
const files: Record<string, unknown> = {
  orders_list: ordersList,
  orders_list_last_page: lastPage,
  // GET /api/manager/orders/[id] answers { order }.
  order_detail: { order: orderDetail },
  order_detail_no_phone: { order: orderDetailNoPhone },
  order_detail_cancelled: { order: orderDetailCancelled },
  order_riders: orderRiders,
  live,
  order_actions: actions,
};
for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + "\n");
}

// The emitter's own sanity: what the app is promised.
const fail = (m: string) => {
  console.error(`  FAIL ${m}`);
  process.exitCode = 1;
};
if (!("phone" in orderDetail.customer)) fail("detail with manager.call_customer carries customer.phone");
if ("phone" in orderDetailNoPhone.customer) fail("detail without manager.call_customer has no customer.phone key");
if (!orderDetail.items.every((i) => typeof i.id === "string" && i.id.length > 0)) fail("detail items carry ids");
if (live.riders.find((r) => r.id === uuid(74))?.phone !== null) fail("out-of-zone rider has no phone");
if (!live.riders.some((r) => r.state === "break")) fail("a rider on a break is in the live fixture");
if (!live.riders.some((r) => r.stale)) fail("a stale rider is in the live fixture");
if (!orderRiders.riders.some((r) => !r.eligible)) fail("an ineligible candidate is in the riders fixture");
console.log(`wrote ${Object.keys(files).length} files to ${out}${process.exitCode ? " (with failures)" : ""}`);
