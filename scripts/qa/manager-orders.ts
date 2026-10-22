/**
 * QA — the Manager app's order list and detail: query parsing, cursor paging,
 * the merged timeline, the allowed actions, the phone-number rule, and the
 * structural rules every read in the data layer must follow. A live section
 * runs against a dev server when BASE is reachable and QA_MANAGER_* are set.
 *
 * Usage: npx tsx scripts/qa/manager-orders.ts   (BASE defaults to http://localhost:3005)
 */
import { readFileSync } from "node:fs";
import { managerCookie } from "./_manager-session";
import { decodeCursor, encodeCursor, parseOrderQuery } from "../../src/lib/ops/order-query";
import { allowedActions, mergeTimeline, toOrderDetail, type DetailFacts } from "../../src/lib/ops/order-detail";
import type { OpsOrderRow } from "../../src/lib/ops/order-row";

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
const NOW = new Date("2026-10-21T08:00:00.000Z"); // 13:30 IST
const P = (s: string) => parseOrderQuery(new URLSearchParams(s), NOW);
const UUID = "3f2c1a9e-1111-4222-8333-444455556666";

console.log("\n── query parsing ──");
let r = P("");
check("no parameters → defaults", r.ok && r.query.limit === 50 && !r.query.statuses && !r.query.queue);
r = P("status=pending");
check("pending → the four active statuses", r.ok && eq(r.query.statuses, ["placed", "kitchen", "ready", "on_the_way"]));
r = P("status=completed");
check("completed → delivered", r.ok && eq(r.query.statuses, ["delivered"]));
r = P("status=today");
check("today → IST-day bounds, no status filter",
  r.ok && r.query.from === "2026-10-20T18:30:00.000Z" && r.query.to === "2026-10-21T18:30:00.000Z" && !r.query.statuses,
  JSON.stringify(r));
r = P("status=ready,cancelled");
check("a comma list of database statuses", r.ok && eq(r.query.statuses, ["ready", "cancelled"]));
r = P("status=bogus");
check("an unknown status → field status", !r.ok && r.field === "status");
r = P("from=2026-10-21T00:00:00Z&to=2026-10-20T00:00:00Z");
check("from after to → field from", !r.ok && r.field === "from");
r = P("from=yesterday");
check("a non-ISO from → field from", !r.ok && r.field === "from");
r = P("vendor=not-a-uuid");
check("a bad vendor uuid → field vendor", !r.ok && r.field === "vendor");
r = P("rider=abc");
check("a bad rider uuid → field rider", !r.ok && r.field === "rider");
r = P("zone=abc");
check("a bad zone uuid → field zone", !r.ok && r.field === "zone");
r = P("limit=101");
check("limit over 100 → field limit", !r.ok && r.field === "limit");
r = P("limit=0");
check("limit 0 → field limit", !r.ok && r.field === "limit");
r = P("queue=late");
check("an unknown queue → field queue", !r.ok && r.field === "queue");
r = P("queue=delayed");
check("queue delayed is accepted", r.ok && r.query.queue === "delayed");
r = P("payment=cod,paid");
check("payment splits into methods and statuses", r.ok && eq(r.query.paymentMethods, ["cod"]) && eq(r.query.paymentStatuses, ["paid"]));
r = P("payment=card");
check("an unknown payment value → field payment", !r.ok && r.field === "payment");
r = P(`q=${UUID}`);
check("a full uuid searches by id", r.ok && eq(r.query.q, { kind: "id", id: UUID }));
r = P("q=%233f2c1a");
check("a code prefix (with #, lower case) searches by code", r.ok && eq(r.query.q, { kind: "code", prefix: "3F2C1A" }));
r = P("q=3f2");
check("fewer than 4 characters → field q", !r.ok && r.field === "q");
r = P("q=hello");
check("a non-hex code → field q", !r.ok && r.field === "q");

console.log("\n── cursor ──");
const cur = encodeCursor("2026-10-21T07:59:00.123456+00:00", UUID);
check("cursor round-trips", eq(decodeCursor(cur), { createdAt: "2026-10-21T07:59:00.123456+00:00", id: UUID }));
check("garbage is rejected", decodeCursor("!!!") === null && decodeCursor(Buffer.from("x|y").toString("base64url")) === null);
r = P(`cursor=${cur}`);
check("a valid cursor parses", r.ok && r.query.cursor?.id === UUID);
r = P("cursor=bad");
check("a bad cursor → field cursor", !r.ok && r.field === "cursor");

console.log("\n── timeline ──");
const actors = new Map([
  ["m1", { id: "m1", name: "Mona", role: "manager" }],
  ["v1", { id: "v1", name: "Vik", role: "restaurant" }],
]);
const tl = mergeTimeline(
  [
    { at: "2026-10-21T07:00:00Z", kind: "status", from: null, to: "placed", actorId: null, reason: null },
    { at: "2026-10-21T07:02:00Z", kind: "status", from: "placed", to: "kitchen", actorId: "v1", reason: null },
  ],
  [{ at: "2026-10-21T07:02:00Z", kind: "accepted", driverId: "d1", actorId: "m1", reason: null, method: null },
   { at: "2026-10-21T07:20:00Z", kind: "picked_up", driverId: "d1", actorId: null, reason: null, method: "code" }],
  [{ at: "2026-10-21T07:05:00Z", authorId: "m1", body: "Called the kitchen" }],
  [{ at: "2026-10-21T07:10:00Z", action: "order.correct.status", actorId: "m1", reason: "Wrong tap", before: { status: "ready" }, after: { status: "kitchen" } },
   { at: "2026-10-21T07:11:00Z", action: "order.advance", actorId: "m1", reason: null, before: null, after: null }],
  actors
);
check("sources interleave by time, oldest first",
  eq(tl.map((e) => `${e.source}:${e.kind}`), ["order:status", "order:status", "delivery:accepted", "ops:note", "ops:corrected", "delivery:picked_up"]),
  tl.map((e) => `${e.source}:${e.kind}`).join(","));
check("equal timestamps keep source order (order before delivery)", tl[1].source === "order" && tl[2].source === "delivery");
check("actors are resolved, unknown or system is null", tl[1].actor?.name === "Vik" && tl[0].actor === null);
check("a vendor actor reads as role vendor", tl[1].actor?.role === "vendor");
check("reasons and methods are kept", tl[4].reason === "Wrong tap" && tl[5].method === "code");
check("a correction shows from/to", tl[4].from === "ready" && tl[4].to === "kitchen");
check("the note body is the reason", tl[3].reason === "Called the kitchen");
check("routine audit rows (advance) do not duplicate the status trail", !tl.some((e) => e.kind === "advance"));

console.log("\n── allowed actions ──");
const all = {
  "manager.move_status": true, "manager.assign_rider": true, "manager.reassign_rider": true,
  "manager.orders.escalate": true, "manager.orders.correct": true, "manager.call_customer": true,
};
const facts = (over: Partial<DetailFacts> = {}): DetailFacts => ({ status: "ready", deliveryStatus: "assigned", ...over });
check("ready with a rider, all switches: advance to on_the_way, reassign, no assign",
  eq(allowedActions(facts(), all), { advance: "on_the_way", cancel: true, assign: false, reassign: true, escalate: true, correct: true, note: true }));
check("without manager.reassign_rider → reassign false",
  allowedActions(facts(), { ...all, "manager.reassign_rider": false }).reassign === false);
check("delivered → no advance, no cancel",
  (() => { const a = allowedActions(facts({ status: "delivered", deliveryStatus: "delivered" }), all); return a.advance === null && !a.cancel && !a.reassign; })());
check("correct and note only with manager.orders.correct",
  (() => { const a = allowedActions(facts(), { ...all, "manager.orders.correct": false }); return !a.correct && !a.note; })());
check("no rider yet → assign, not reassign",
  (() => { const a = allowedActions(facts({ deliveryStatus: null }), all); return a.assign && !a.reassign; })());
check("an unassigned delivery row → assign", allowedActions(facts({ deliveryStatus: "unassigned" }), all).assign);
check("a failed delivery on a live order → assign (a new leg), not reassign",
  (() => { const a = allowedActions(facts({ status: "on_the_way", deliveryStatus: "failed" }), all); return a.assign && !a.reassign; })());
check("a cancelled order cannot be corrected", allowedActions(facts({ status: "cancelled", deliveryStatus: "cancelled" }), all).correct === false);
check("without manager.move_status → no advance, no cancel",
  (() => { const a = allowedActions(facts(), { ...all, "manager.move_status": false }); return a.advance === null && !a.cancel; })());

console.log("\n── the phone rule ──");
const row: OpsOrderRow = {
  id: UUID, status: "ready", createdAt: "2026-10-21T07:00:00Z", acceptedAt: "2026-10-21T07:02:00Z", readyAt: "2026-10-21T07:30:00Z",
  prepMinutes: 20, zoneId: "z1", etaMin: 40, etaMax: 50, vendor: { id: "v", name: "Spice Hub", lat: 21.7, lng: 81.5 },
  drop: { lat: 21.71, lng: 81.52 }, customerName: "Asha", total: 420, itemCount: 2, payment: { method: "cod", status: "pending" },
  byPhone: false, delivery: { status: "assigned", driverId: "d1", pickedUpAt: null, failedAt: null }, riderName: "Ravi", riderCode: "DR-0001",
};
const extra = {
  items: [{ id: "it-1", name: "Paneer", qty: 2, price: 180 }],
  money: { subtotal: 360, discount: 0, deliveryFee: 40, tax: 20, tip: 0, total: 420 },
  pickup: { name: "Spice Hub", address: "Station Road", lat: 21.7, lng: 81.5, phone: "+919800000000" },
  drop: { label: "Home", address: "12 Gandhi Nagar", landmark: null, lat: 21.71, lng: 81.52, note: "Blue gate behind the temple" },
  customer: { name: "Asha", phone: "+919811111111" },
  delivery: null,
  timeline: [],
  tickets: [],
};
const without = toOrderDetail(row, extra, { "manager.call_customer": false }, NOW);
check("without manager.call_customer the phone key is absent, not null", !("phone" in without.customer), JSON.stringify(without.customer));
const withPhone = toOrderDetail(row, extra, { "manager.call_customer": true }, NOW);
check("with it, the phone is there", withPhone.customer.phone === "+919811111111");
check("line totals are qty × price", withPhone.items[0].lineTotal === 360);
check("detail items carry the order_items id (item-unavailable correction)", withPhone.items[0].id === "it-1");
check("the drop carries the ops delivery note for the rider", withPhone.drop.note === "Blue gate behind the temple");
const noteTimeline = mergeTimeline([], [], [], [
  { at: "2026-10-21T07:40:00Z", action: "order.correct.address_note", actorId: "m1", reason: "Customer called", before: { note: null }, after: { note: "Blue gate" } },
], new Map([["m1", { id: "m1", name: "Mona", role: "manager" }]]));
check("an address note correction shows on the timeline", noteTimeline.some((e) => e.kind === "corrected" && e.method === "address_note"));
check("the detail carries the list fields", withPhone.code === UUID.slice(0, 8).toUpperCase() && withPhone.rider?.code === "DR-0001");

console.log("\n── structure ──");
const listRoute = readFileSync("src/app/api/manager/orders/route.ts", "utf8");
const detailRoute = readFileSync("src/app/api/manager/orders/[id]/route.ts", "utf8");
const data = readFileSync("src/lib/data-access/manager-ops-orders.ts", "utf8");
check("the list route opens with managerApiContext(\"manager.orders.view\")", /managerApiContext\("manager\.orders\.view"\)/.test(listRoute));
check("the detail route opens with managerApiContext(\"manager.orders.view\")", /managerApiContext\("manager\.orders\.view"\)/.test(detailRoute));
check("the data layer never selects * from orders", !/select\(\s*["'`]\*["'`]\s*\)/.test(data));
const orderChains = data.split(/\.from\("orders"\)/).slice(1);
check("every orders read in the data layer is zone-scoped",
  orderChains.length > 0 && orderChains.every((chain) => /applyZoneScope|scopeZoneIds|\.in\("zone_id", zones/.test(chain.slice(0, 1500))),
  `${orderChains.length} chains`);
check("the data layer is server-only", data.startsWith('import "server-only";'));

const BASE = process.env.BASE ?? "http://localhost:3005";
async function reachable(): Promise<boolean> {
  try { await fetch(`${BASE}/api/app-version?app=manager&versionCode=1`, { signal: AbortSignal.timeout(3000) }); return true; }
  catch { return false; }
}
async function live(): Promise<void> {
console.log("\n── live (optional) ──");
if (await reachable()) {
  const res = await fetch(`${BASE}/api/manager/orders`);
  check("unauthenticated list → 401", res.status === 401);
  const res2 = await fetch(`${BASE}/api/manager/orders/${UUID}`);
  check("unauthenticated detail → 401", res2.status === 401);
  const cookie = await managerCookie();
  if (!cookie) console.log("  (skipped signed-in checks: no manager login)");
  else {
    const h = { cookie };
    const p1 = await (await fetch(`${BASE}/api/manager/orders?limit=2`, { headers: h })).json();
    if (p1.nextCursor) {
      const p2 = await (await fetch(`${BASE}/api/manager/orders?limit=2&cursor=${p1.nextCursor}`, { headers: h })).json();
      const ids1 = new Set(p1.items.map((x: { id: string }) => x.id));
      check("keyset pages are disjoint", p2.items.every((x: { id: string }) => !ids1.has(x.id)));
    }
    if (p1.items[0]) {
      const code = p1.items[0].id.slice(0, 6);
      const found = await (await fetch(`${BASE}/api/manager/orders?q=${code}`, { headers: h })).json();
      check("q=<first 6 chars> finds the order", found.items.some((x: { id: string }) => x.id === p1.items[0].id));
    }
    const out = await fetch(`${BASE}/api/manager/orders/00000000-0000-4000-8000-000000000000`, { headers: h });
    check("an unknown or out-of-zone id → 404", out.status === 404);
  }
} else {
  console.log(`  (skipped: ${BASE} unreachable)`);
}
}

void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
