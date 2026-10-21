/**
 * QA — the live operations rules: delays, ETAs, rider marker states, rider
 * eligibility for (re)assignment, and the signals Phase 8's alerts will read.
 *
 * Pure, no I/O. Usage: npx tsx scripts/qa/manager-live-rules.ts
 */
import {
  INACTIVE_MINUTES,
  PICKUP_WAIT_MINUTES,
  PREP_GRACE_MINUTES,
  STALE_FIX_SECONDS,
  UNASSIGNED_MINUTES,
  delayFor,
  liveSignals,
  orderEtaView,
  rankCandidates,
  riderEligibility,
  riderMarkerState,
  type LiveOrderFacts,
  type RiderFacts,
} from "../../src/lib/ops/live-rules";
import { readFileSync } from "node:fs";
import { buildLiveSnapshot, type LiveRows } from "../../src/lib/ops/live-snapshot";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const agoS = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function order(over: Partial<LiveOrderFacts> = {}): LiveOrderFacts {
  return {
    status: "kitchen",
    createdAt: ago(35),
    acceptedAt: ago(30),
    readyAt: null,
    prepMinutes: 20,
    etaMin: 60,
    etaMax: 75,
    distanceKm: 2,
    delivery: null,
    ...over,
  };
}
function rider(over: Partial<RiderFacts> = {}): RiderFacts {
  return {
    id: "r1",
    isOnline: true,
    breakUntil: null,
    lastFixAt: agoS(30),
    lat: 21.7,
    lng: 81.5,
    zoneIds: ["zA"],
    suspended: false,
    activeDeliveries: 0,
    ...over,
  };
}

console.log("\n── constants ──");
check("thresholds are the plan's", STALE_FIX_SECONDS === 120 && INACTIVE_MINUTES === 5 && UNASSIGNED_MINUTES === 5
  && PREP_GRACE_MINUTES === 5 && PICKUP_WAIT_MINUTES === 10);

console.log("\n── delays ──");
const assigned = { status: "assigned", driverId: "r1", pickedUpAt: null, failedAt: null };
check("kitchen, accepted 30 min ago, prep 20 → prep delay of 5",
  eq(delayFor(order({ delivery: assigned }), NOW), { kind: "prep", minutes: 5 }), JSON.stringify(delayFor(order({ delivery: assigned }), NOW)));
check("...accepted 24 min ago → inside the grace, no delay",
  delayFor(order({ acceptedAt: ago(24), delivery: assigned }), NOW) === null);
check("ready 12 min ago, rider assigned, not picked up → pickup delay of 2",
  eq(delayFor(order({ status: "ready", readyAt: ago(12), delivery: assigned }), NOW), { kind: "pickup", minutes: 2 }));
check("ready 6 min ago with no rider → unassigned 1, outranking pickup",
  eq(delayFor(order({ status: "ready", readyAt: ago(6), delivery: null }), NOW), { kind: "unassigned", minutes: 1 }));
check("an unassigned delivery row counts as no rider",
  eq(delayFor(order({ status: "ready", readyAt: ago(6), delivery: { status: "unassigned", driverId: null, pickedUpAt: null, failedAt: null } }), NOW),
    { kind: "unassigned", minutes: 1 }));
const lateOrder = order({ status: "ready", createdAt: ago(80), acceptedAt: ago(78), readyAt: ago(12), etaMin: 30, etaMax: 40, delivery: assigned });
check("a late ETA → delivery delay, outranking pickup", delayFor(lateOrder, NOW)?.kind === "delivery", JSON.stringify(delayFor(lateOrder, NOW)));
check("a delivered order carries no delay", delayFor(order({ status: "delivered" }), NOW) === null);
check("a cancelled order carries no delay", delayFor(order({ status: "cancelled" }), NOW) === null);
check("a placed order is not prep-delayed", delayFor(order({ status: "placed", acceptedAt: null }), NOW) === null);

console.log("\n── ETA view ──");
const view = orderEtaView(order(), NOW);
check("kitchen order: pickupAt = accepted + prep", view?.pickupAt === new Date(NOW.getTime() - 10 * 60_000).toISOString(), view?.pickupAt ?? "null");
check("...with an expected and a due time", !!view?.expectedAt && !!view?.dueAt);
check("ready order: pickupAt = readyAt",
  orderEtaView(order({ status: "ready", readyAt: ago(3) }), NOW)?.pickupAt === ago(3));
check("terminal order: no ETA", orderEtaView(order({ status: "delivered" }), NOW) === null);
check("late order: late with minutes", orderEtaView(lateOrder, NOW)?.late === true && (orderEtaView(lateOrder, NOW)?.lateByMinutes ?? 0) > 0);

console.log("\n── rider markers ──");
check("fix 121 s old → stale", riderMarkerState(rider({ lastFixAt: agoS(121) }), NOW) === "stale");
check("fix 119 s old → available", riderMarkerState(rider({ lastFixAt: agoS(119) }), NOW) === "available");
check("on a break → break, even with a stale fix",
  riderMarkerState(rider({ breakUntil: new Date(NOW.getTime() + 600_000).toISOString(), lastFixAt: agoS(900) }), NOW) === "break");
check("online with an active delivery → on_delivery", riderMarkerState(rider({ activeDeliveries: 1 }), NOW) === "on_delivery");
check("no fix at all → stale", riderMarkerState(rider({ lastFixAt: null }), NOW) === "stale");

console.log("\n── eligibility ──");
const ctx = { orderZoneId: "zA", currentRiderId: null, shop: { lat: 21.7, lng: 81.5 } };
const why = (r: RiderFacts, c = ctx) => riderEligibility(r, c, NOW).ineligibleReason;
check("offline first", why(rider({ isOnline: false, breakUntil: new Date(NOW.getTime() + 60_000).toISOString(), lastFixAt: null, suspended: true, zoneIds: [] })) === "offline");
check("then on_break", why(rider({ breakUntil: new Date(NOW.getTime() + 60_000).toISOString(), lastFixAt: null, suspended: true })) === "on_break");
check("then stale_fix (older than 5 min)", why(rider({ lastFixAt: ago(6), suspended: true })) === "stale_fix");
check("a 4-minute-old fix is still fresh for dispatch", why(rider({ lastFixAt: ago(4) })) === null);
check("then suspended", why(rider({ suspended: true, zoneIds: [] })) === "suspended");
check("then out_of_zone", why(rider({ zoneIds: ["zB"] })) === "out_of_zone");
check("a rider with no zones is out of zone (fail closed)", why(rider({ zoneIds: [] })) === "out_of_zone");
check("then current_rider", why(rider(), { ...ctx, currentRiderId: "r1" }) === "current_rider");
const elig = riderEligibility(rider({ lat: 21.71, lng: 81.5 }), ctx, NOW);
check("eligible with a distance to the shop", elig.eligible && elig.distanceKm !== null && elig.distanceKm > 1 && elig.distanceKm < 1.3,
  String(elig.distanceKm));
check("no fix → distance null", riderEligibility(rider({ lat: null, lng: null, lastFixAt: null }), ctx, NOW).distanceKm === null);

console.log("\n── ranking ──");
const ranked = rankCandidates([
  { id: "far", eligible: true, distanceKm: 5, activeDeliveries: 0 },
  { id: "bad", eligible: false, distanceKm: 0.1, activeDeliveries: 0 },
  { id: "near-busy", eligible: true, distanceKm: 1, activeDeliveries: 2 },
  { id: "near-free", eligible: true, distanceKm: 1, activeDeliveries: 0 },
  { id: "nofix", eligible: true, distanceKm: null, activeDeliveries: 0 },
]);
check("eligible first, nearer first, then lighter load, unknown distance last",
  eq(ranked.map((x) => x.id), ["near-free", "near-busy", "far", "nofix", "bad"]), ranked.map((x) => x.id).join(","));

console.log("\n── signals ──");
const sig = liveSignals(
  [
    { ...order({ status: "on_the_way", delivery: { status: "picked_up", driverId: "r1", pickedUpAt: ago(10), failedAt: null } }), id: "o1" },
    { ...order({ status: "ready", readyAt: ago(30), delivery: { status: "failed", driverId: "r2", pickedUpAt: null, failedAt: ago(30) } }), id: "o2" },
    { ...order({ status: "ready", readyAt: ago(200), delivery: { status: "failed", driverId: "r2", pickedUpAt: null, failedAt: ago(180) } }), id: "o3" },
    { ...order({ status: "ready", readyAt: ago(8), delivery: null }), id: "o4" },
    { ...order({ acceptedAt: ago(40), delivery: assigned }), id: "o5" },
  ],
  [
    { ...rider({ id: "r1", lastFixAt: ago(6), activeDeliveries: 1 }), activeOrderIds: ["o1"] },
    { ...rider({ id: "r3", lastFixAt: ago(6) }), activeOrderIds: [] },
  ],
  NOW
);
const kinds = (k: string) => sig.filter((s) => s.kind === k);
check("rider_inactive for a rider with an active order and a 6-min-old fix",
  kinds("rider_inactive").length === 1 && kinds("rider_inactive")[0].riderId === "r1" && kinds("rider_inactive")[0].minutes === 6);
check("...but not for an idle rider", !kinds("rider_inactive").some((s) => s.riderId === "r3"));
check("delivery_failed for a failure 30 min ago, none for one 3 h ago",
  kinds("delivery_failed").length === 1 && kinds("delivery_failed")[0].orderId === "o2");
check("order_unassigned for the waiting ready order", kinds("order_unassigned").some((s) => s.orderId === "o4"));
check("prep_delayed for the slow kitchen", kinds("prep_delayed").some((s) => s.orderId === "o5" && s.minutes === 15));

console.log("\n── the live snapshot ──");
const rows: LiveRows = {
  orders: [
    { id: "o1", status: "on_the_way", createdAt: ago(30), acceptedAt: ago(28), readyAt: ago(10), prepMinutes: 15, zoneId: "zA",
      etaMin: 40, etaMax: 50, vendor: { id: "v1", name: "Spice Hub", lat: 21.7, lng: 81.5 }, drop: { lat: 21.72, lng: 81.52 },
      customerName: "Asha", total: 420, itemCount: 2, payment: { method: "cod", status: "pending" }, byPhone: false,
      delivery: { status: "picked_up", driverId: "d1", pickedUpAt: ago(5), failedAt: null }, riderName: "Ravi", riderCode: "DR-0001" },
    { id: "o2", status: "ready", createdAt: ago(20), acceptedAt: ago(18), readyAt: ago(7), prepMinutes: 10, zoneId: "zA",
      etaMin: 40, etaMax: 50, vendor: { id: "v1", name: "Spice Hub", lat: 21.7, lng: 81.5 }, drop: { lat: 21.69, lng: 81.49 },
      customerName: null, total: 300, itemCount: 1, payment: { method: "online", status: "paid" }, byPhone: true,
      delivery: null, riderName: null, riderCode: null },
    { id: "o3", status: "kitchen", createdAt: ago(5), acceptedAt: ago(4), readyAt: null, prepMinutes: 20, zoneId: "zA",
      etaMin: 40, etaMax: 50, vendor: { id: "v1", name: "Spice Hub", lat: 21.7, lng: 81.5 }, drop: null,
      customerName: "Bina", total: 200, itemCount: 1, payment: { method: "cod", status: "pending" }, byPhone: false,
      delivery: null, riderName: null, riderCode: null },
  ],
  riders: [
    { id: "d1", name: "Ravi", code: "DR-0001", isOnline: false, breakUntil: null, lastFixAt: ago(9), lat: 21.71, lng: 81.51,
      zoneIds: ["zA"], suspended: false, activeOrderIds: ["o1"] },
    { id: "d2", name: "Sunil", code: "DR-0002", isOnline: true, breakUntil: null, lastFixAt: agoS(20), lat: 21.7, lng: 81.5,
      zoneIds: ["zA"], suspended: false, activeOrderIds: [] },
    { id: "d3", name: "Gone", code: "DR-0003", isOnline: false, breakUntil: null, lastFixAt: ago(60), lat: 21.7, lng: 81.5,
      zoneIds: ["zA"], suspended: false, activeOrderIds: [] },
  ],
  failedRecently: [],
};
const snap = buildLiveSnapshot(rows, NOW);
check("an offline rider without an active delivery is not on the map", !snap.riders.some((r) => r.id === "d3"));
const d1 = snap.riders.find((r) => r.id === "d1");
check("an offline rider holding a delivery is, and is stale with an old fix", d1?.state === "stale" && d1.stale === true && d1.lastFixAgeSeconds === 540);
check("an online rider is available", snap.riders.find((r) => r.id === "d2")?.state === "available");
check("lanes count by status", eq(snap.lanes, { placed: 0, kitchen: 1, ready: 1, on_the_way: 1 }));
check("unassigned lists the waiting ready order", eq(snap.unassigned, ["o2"]));
check("delayed agrees with delayFor", eq(snap.delayed, [{ orderId: "o2", kind: "unassigned", minutes: 2 }]), JSON.stringify(snap.delayed));
check("orders carry pickup and drop points", snap.orders[0].pickupPoint?.lat === 21.7 && snap.orders[0].dropPoint?.lat === 21.72);
check("thresholds echo the constants",
  eq(snap.thresholds, { staleSeconds: 120, inactiveMinutes: 5, unassignedMinutes: 5, prepGraceMinutes: 5, pickupWaitMinutes: 10 }));
check("the rider_inactive signal reaches the snapshot", snap.signals.some((s) => s.kind === "rider_inactive" && s.riderId === "d1"));
check("generatedAt is now", snap.generatedAt === NOW.toISOString());

console.log("\n── rider phone on the live map (call rule) ──");
const phoneRows: LiveRows = {
  ...rows,
  riders: [
    { ...rows.riders[0], phone: "+919800000001" }, // zA, carrying o1
    { ...rows.riders[1], phone: "+919800000002" }, // zA, online
    { id: "d4", name: "Visitor", code: "DR-0004", isOnline: true, breakUntil: null, lastFixAt: agoS(10), lat: 21.7, lng: 81.5,
      zoneIds: ["zB"], suspended: false, activeOrderIds: [], phone: "+919800000004" },
    { id: "d5", name: "No zone", code: null, isOnline: true, breakUntil: null, lastFixAt: agoS(10), lat: 21.7, lng: 81.5,
      zoneIds: [], suspended: false, activeOrderIds: [], phone: "+919800000005" },
  ],
  scopeZoneIds: ["zA"],
};
const ps = buildLiveSnapshot(phoneRows, NOW);
const phoneOf = (id: string) => ps.riders.find((r) => r.id === id)?.phone;
check("an in-zone rider carrying an order shows their phone", phoneOf("d1") === "+919800000001");
check("an in-zone online rider shows their phone", phoneOf("d2") === "+919800000002");
check("a rider from another zone never shows a phone", phoneOf("d4") === null);
check("a rider with no zone never shows a phone (fail closed)", phoneOf("d5") === null);
check("an admin (scopeZoneIds null) sees phones of every visible rider",
  buildLiveSnapshot({ ...phoneRows, scopeZoneIds: null }, NOW).riders.every((r) => typeof r.phone === "string"));
check("without scopeZoneIds given, no phone is ever shown (fail closed)",
  buildLiveSnapshot({ ...phoneRows, scopeZoneIds: undefined }, NOW).riders.every((r) => r.phone === null));
check("rows without a phone give null, not undefined", snap.riders.every((r) => r.phone === null));

console.log("\n── the live route ──");
const route = readFileSync("src/app/api/manager/live/route.ts", "utf8");
check("the route opens with managerApiContext(\"manager.live.view\")", /managerApiContext\("manager\.live\.view"\)/.test(route));
check("a malformed zone is a 400, not everything", /bad_request/.test(route) && /narrowScope\(/.test(route));
const live = readFileSync("src/lib/data-access/manager-live.ts", "utf8");
check("the live data layer is server-only and scoped", live.startsWith('import "server-only";') && /scopeZoneIds\(/.test(live));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
