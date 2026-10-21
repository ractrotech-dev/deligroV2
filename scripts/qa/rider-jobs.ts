/**
 * Rider offers, data layer — accept, reject, the sweep, the board — against a
 * fake in-memory PostgREST. No database, no network beyond localhost.
 *
 *   npm run test:rider-jobs
 *
 * The modules are `server-only`, so tsx runs with the `react-server` condition.
 * The fake is the place to stage what a real database makes hard: a second
 * rider winning the race, a table or column that migration 0081/0082 has not
 * created, and the two triggers that matter here (`log_delivery_event`'s
 * `offered` and `accepted` rows, which read the position off the delivery row).
 *
 * The offer window and the clock are passed in (the `opts` argument every
 * function takes) because platform settings need a Next request scope.
 */
import http from "node:http";
import assert from "node:assert/strict";

// No push may leave this script, whatever the shell has exported.
for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const db: Record<string, Row[]> = {};
const mode = {
  missingTables: new Set<string>(),
  /** "table.column": a select naming it is 42703, a write naming it is PGRST204. */
  missingColumns: new Set<string>(),
  /** Tables whose reads fail with a plain database error. */
  failReads: new Set<string>(),
  /** Run once, just before the next PATCH on deliveries is applied (a race). */
  beforeDeliveryPatch: null as null | (() => void),
};
const obsEvents: Row[] = [];
const patchBodies: Record<string, Row[]> = {};
let eventSeq = 0;
let deliverySeq = 0;
let shiftSeq = 0;

const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(patchBodies)) delete patchBodies[k];
  mode.missingTables.clear();
  mode.missingColumns.clear();
  mode.failReads.clear();
  mode.beforeDeliveryPatch = null;
};
const t = (name: string): Row[] => (db[name] ??= []);

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or", "and"]);

function compare(a: unknown, b: string): number {
  const n = Number(b);
  if (typeof a === "number" && Number.isFinite(n)) return a - n;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key) || key.includes(".")) continue;
    const value = row[key];
    const negate = raw.startsWith("not.");
    const body = negate ? raw.slice(4) : raw;
    const dot = body.indexOf(".");
    const op = body.slice(0, dot);
    const arg = body.slice(dot + 1);
    let hit: boolean;
    switch (op) {
      case "eq":
        hit = String(value) === arg;
        break;
      case "neq":
        hit = String(value) !== arg;
        break;
      case "in":
        hit = arg
          .slice(1, -1)
          .split(",")
          .map((v) => v.replace(/^"|"$/g, ""))
          .includes(String(value));
        break;
      case "is":
        hit = arg === "null" ? value === null || value === undefined : String(value) === arg;
        break;
      case "gt":
        hit = value != null && compare(value, arg) > 0;
        break;
      case "gte":
        hit = value != null && compare(value, arg) >= 0;
        break;
      case "lt":
        hit = value != null && compare(value, arg) < 0;
        break;
      case "lte":
        hit = value != null && compare(value, arg) <= 0;
        break;
      default:
        throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}

function ordered(rows: Row[], url: URL): Row[] {
  const spec = url.searchParams.get("order");
  if (!spec) return rows;
  const [col, dir] = spec.split(",")[0].split(".");
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[col];
    const y = b[col];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

/** `log_delivery_event`'s two rows that matter here: it reads the position off the delivery row. */
function deliveryTriggers(oldRow: Row | null, next: Row): void {
  const log = (kind: string, driver: unknown) =>
    t("delivery_events").push({
      id: ++eventSeq,
      delivery_id: next.id,
      order_id: next.order_id,
      driver_id: driver,
      kind,
      method: null,
      reason: null,
      lat: next.driver_lat ?? null,
      lng: next.driver_lng ?? null,
      created_at: new Date().toISOString(),
    });
  if (next.offered_driver_id && next.offered_driver_id !== (oldRow?.offered_driver_id ?? null)) {
    log("offered", next.offered_driver_id);
  }
  if (next.status === "assigned" && (oldRow?.status ?? "unassigned") === "unassigned") {
    log("accepted", next.driver_id);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | Row[] | null = raw ? JSON.parse(raw) : null;
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };

    if (table === "rpc/obs_ingest" && body && !Array.isArray(body)) {
      obsEvents.push(...(body.p_events as Row[]));
      return send(200, null);
    }
    if (table.startsWith("rpc/")) return send(200, null);

    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
    }
    for (const entry of mode.missingColumns) {
      const [tbl, col] = entry.split(".");
      if (tbl !== table) continue;
      const word = new RegExp(`(^|[^a-z_])${col}([^a-z_]|$)`);
      const named =
        req.method === "GET"
          ? word.test(url.searchParams.get("select") ?? "") ||
            [...url.searchParams.keys()].includes(col)
          : (Array.isArray(body) ? body : [body ?? {}]).some((r) => col in r);
      if (named) {
        return req.method === "GET"
          ? send(400, { code: "42703", message: `column ${table}.${col} does not exist` })
          : send(400, { code: "PGRST204", message: `Could not find the '${col}' column of '${table}' in the schema cache` });
      }
    }

    if (req.method === "GET") {
      if (mode.failReads.has(table)) return send(500, { code: "XX000", message: "boom" });
      let rows = ordered(t(table).filter((r) => matches(r, url)), url);
      const offset = Number(url.searchParams.get("offset")) || 0;
      if (offset > 0) rows = rows.slice(offset);
      const limit = Number(url.searchParams.get("limit"));
      if (limit > 0) rows = rows.slice(0, limit);
      return respond(rows);
    }

    if (req.method === "POST" && body) {
      const incoming = Array.isArray(body) ? body : [body];
      const out: Row[] = [];
      for (const item of incoming) {
        if (table === "deliveries") {
          if (t(table).some((r) => r.order_id === item.order_id)) {
            return send(409, { code: "23505", message: "duplicate key value violates unique constraint" });
          }
          const row: Row = { id: `d${++deliverySeq}`, offered_driver_id: null, offered_at: null, driver_id: null, ...item };
          t(table).push(row);
          deliveryTriggers(null, row);
          out.push(row);
        } else if (table === "rider_status") {
          const existing = t(table).find((r) => r.driver_id === item.driver_id);
          if (existing) Object.assign(existing, item);
          else t(table).push({ ...item });
          out.push(existing ?? item);
        } else if (table === "rider_shifts") {
          if (t(table).some((s) => s.driver_id === item.driver_id && !s.ended_at)) {
            return send(409, { code: "23505", message: "duplicate key" });
          }
          const row = { id: ++shiftSeq, ended_at: null, ...item };
          t(table).push(row);
          out.push(row);
        } else if (table === "delivery_events") {
          const row = { id: ++eventSeq, created_at: new Date().toISOString(), method: null, reason: null, lat: null, lng: null, ...item };
          t(table).push(row);
          out.push(row);
        } else {
          t(table).push({ ...item });
          out.push(item);
        }
      }
      return send(201, out);
    }

    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      (patchBodies[table] ??= []).push(body);
      if (table === "deliveries" && mode.beforeDeliveryPatch) {
        const hook = mode.beforeDeliveryPatch;
        mode.beforeDeliveryPatch = null;
        hook();
      }
      const hit = t(table).filter((r) => matches(r, url));
      const out: Row[] = [];
      for (const row of hit) {
        const before = { ...row };
        Object.assign(row, body);
        if (table === "deliveries") deliveryTriggers(before, row);
        out.push(row);
      }
      return send(200, out);
    }

    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`ok   ${name}`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const SHOP = { lat: 21.7157, lng: 81.5335 };
const DROP = { lat: 21.73, lng: 81.55 };
const RIDER_AT = { lat: 21.716, lng: 81.534 };
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const O1 = "10000000-0000-4000-8000-000000000001";
const O2 = "10000000-0000-4000-8000-000000000002";
const WINDOW = 180;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;

// 0141: every order carries its shop's zone and every rider works at least one
// zone; dispatch only offers an order to riders in its zone.
const ZONE = "20000000-0000-4000-8000-000000000001";

function seedRider(id: string, name: string, over: Row = {}, at: { lat: number; lng: number } = RIDER_AT): void {
  t("profiles").push({ id, full_name: name, role: "driver", phone: `+9100000000${id.slice(-1)}` });
  t("staff_zones").push({ user_id: id, zone_id: ZONE });
  t("rider_status").push({
    driver_id: id,
    is_online: true,
    break_until: null,
    online_since: ago(60 * MIN),
    last_fix_at: ago(10 * SEC),
    last_lat: at.lat,
    last_lng: at.lng,
    updated_at: ago(60 * MIN),
    ...over,
  });
}

function seedOrder(id: string, over: Row = {}): Row {
  const row: Row = {
    id,
    zone_id: ZONE,
    status: "ready",
    total: 350,
    tip: 0,
    delivery_fee: 30,
    tax_amount: 0,
    created_at: ago(30 * MIN),
    accepted_at: ago(25 * MIN),
    ready_at: ago(10 * MIN),
    address: { label: "Home", line: "12 Lane, Bemetara", lat: DROP.lat, lng: DROP.lng },
    delivery_instructions: "Gate code 4411",
    payment_method: "cod",
    payment_status: "pending",
    pickup_otp: "1234",
    delivery_otp: "5678",
    restaurants: {
      name: "Saffron Kitchen",
      address: "Main Road",
      lat: SHOP.lat,
      lng: SHOP.lng,
      prep_minutes: 20,
      eta_min: 25,
      eta_max: 35,
      phone: "+910000011111",
      owner_id: "owner-1",
    },
    profiles: { full_name: "Asha", phone: "+919999900001" },
    order_items: [
      { name: "Paneer", qty: 2 },
      { name: "Naan", qty: 3 },
    ],
    deliveries: null,
    ...over,
  };
  t("orders").push(row);
  return row;
}

function seedDelivery(orderId: string, over: Row = {}): Row {
  const row: Row = {
    id: `d${++deliverySeq}`,
    order_id: orderId,
    status: "unassigned",
    driver_id: null,
    offered_driver_id: null,
    offered_at: null,
    ...over,
  };
  t("deliveries").push(row);
  return row;
}

const deliveryOf = (orderId: string) => t("deliveries").find((d) => d.order_id === orderId);
const eventsOf = (orderId: string, kind?: string) =>
  t("delivery_events").filter((e) => e.order_id === orderId && (kind ? e.kind === kind : true));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const jobs = await import("../../src/lib/data-access/rider-jobs");
  const orders = await import("../../src/lib/data-access/driver-orders");
  const status = await import("../../src/lib/data-access/rider-status");
  const sweep = await import("../../src/lib/dispatch/sweep");
  const dispatch = await import("../../src/lib/dispatch/rider-dispatch");
  const { haversineKm } = await import("../../src/lib/geo/distance");
  const { roadKmFallback } = await import("../../src/lib/rider/offer-window");

  const expectedKm = roadKmFallback(haversineKm(SHOP, DROP));
  // The sweep latches an order it has tried (per order, per state), process-wide:
  // each sweep scenario gets orders of its own.
  let swSeq = 0;
  const SW = () => `40000000-0000-4000-8000-${String(++swSeq).padStart(12, "0")}`;
  let SO1 = SW();
  let SO2 = SW();
  const { DEFAULT_SETTINGS } = await import("../../src/lib/settings-defaults");
  const { roadDistanceKm } = await import("../../src/lib/rider/road-distance");

  // The routing server is faked: no test reaches the public OSRM. The default is
  // "error", so an accept leaves its straight-line estimate in place and the
  // assertions about it cannot race the (deferred) upgrade.
  const routing = {
    mode: "error" as "ok" | "error" | "abort" | "http500" | "noroute" | "garbage",
    metres: 4321,
    gate: null as null | Promise<void>,
    before: null as null | (() => void),
  };
  const routeCalls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    routeCalls.push(String(input));
    if (routing.gate) await routing.gate;
    routing.before?.();
    switch (routing.mode) {
      case "ok":
        return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: routing.metres }] }), { status: 200 });
      case "abort":
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      case "http500":
        return new Response("boom", { status: 500 });
      case "noroute":
        return new Response(JSON.stringify({ code: "NoRoute", routes: [] }), { status: 200 });
      case "garbage":
        return new Response("<html>", { status: 200 });
      default:
        throw new Error("network down");
    }
  }) as typeof fetch;
  const ringStops: [string, string][] = [];
  const stopRing = async (driverId: string, orderId: string) => {
    ringStops.push([driverId, orderId]);
  };
  const routingOpts = { routingBaseUrl: "https://router.test", fetch: fakeFetch, stopRing };
  const opts = { windowSeconds: WINDOW, settings: DEFAULT_SETTINGS, ...routingOpts };
  /** Wait for a deferred write to land (outside a request scope it is a detached promise). */
  const settle = async (cond: () => boolean, ms = 2000) => {
    for (let waited = 0; waited < ms && !cond(); waited += 20) await sleep(20);
  };
  const ROUTE_URL = `https://router.test/route/v1/driving/${SHOP.lng},${SHOP.lat};${DROP.lng},${DROP.lat}?overview=false`;

  // =========================================================================
  // acceptOffer
  // =========================================================================
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);

  // --- not online
  t("rider_status").find((r) => r.driver_id === A)!.is_online = false;
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "not_online" });
  assert.equal(deliveryOf(O1), undefined, "nothing written for an offline rider");
  t("rider_status").length = 0;
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "not_online" });
  ok("accept: a rider who is offline (or has never been online) gets not_online and nothing is written");

  // --- open order, no offer row: insert with distance and position
  seedRider(A, "alpha");
  t("profiles").length = 0;
  let r = await jobs.acceptOffer(A, O1, opts);
  assert.deepEqual(r, { ok: true });
  let d = deliveryOf(O1)!;
  assert.equal(d.status, "assigned");
  assert.equal(d.driver_id, A);
  assert.equal(d.distance_km, expectedKm, "distance_km = road fallback of the shop->drop straight line");
  assert.equal(d.distance_source, "estimate", "...recorded as an estimate");
  assert.equal(d.driver_lat, RIDER_AT.lat);
  assert.equal(d.driver_lng, RIDER_AT.lng);
  const accepted = eventsOf(O1, "accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].lat, RIDER_AT.lat, "the accepted event is where the rider was");
  assert.equal(accepted[0].lng, RIDER_AT.lng);
  ok("accept an open order: assigned, distance_km stored, the position rides in the same write (event lat/lng)");

  // --- already taken
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "already_taken" });
  ok("accept an order somebody holds: already_taken");

  // --- order not ready
  reset();
  seedRider(A, "alpha");
  seedOrder(O1, { status: "kitchen" });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "not_ready" });
  assert.equal(deliveryOf(O1), undefined);
  ok("accept an order that is not ready: not_ready");

  // --- a standing offer for me
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: A, offered_at: ago(60 * SEC) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  d = deliveryOf(O1)!;
  assert.equal(d.status, "assigned");
  assert.equal(d.driver_id, A);
  assert.equal(d.distance_km, expectedKm);
  assert.equal(eventsOf(O1, "accepted")[0].lat, RIDER_AT.lat);
  ok("accept an offer held for me: claimed with distance_km and position");

  // --- held for someone else
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: B, offered_at: ago(60 * SEC) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "reserved" });
  assert.equal(deliveryOf(O1)!.status, "unassigned");
  ok("accept an offer held for another rider: reserved");

  // --- my window passed and somebody else has been offered it since
  t("delivery_events").push({ id: ++eventSeq, delivery_id: "d", order_id: O1, driver_id: A, kind: "lapsed", created_at: ago(2 * MIN) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "offer_expired" });
  ok("accept after my own window lapsed and the order went to someone else: offer_expired (not reserved)");

  // --- fell open to everyone: accepting succeeds
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: B, offered_at: ago(200 * SEC) });
  t("delivery_events").push({ id: ++eventSeq, delivery_id: "d", order_id: O1, driver_id: A, kind: "lapsed", created_at: ago(5 * MIN) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  ok("accept an order whose offer fell open to everyone: succeeds");

  // --- the window is the setting's
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: B, offered_at: ago(150 * SEC) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, { windowSeconds: 180 }), { ok: false, error: "reserved" });
  assert.deepEqual(await jobs.acceptOffer(A, O1, { windowSeconds: 120 }), { ok: true });
  ok("the same 150 s old offer is held under a 180 s window and open under a 120 s one");

  // --- a rival wins between our read and our claim
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  const standing = seedDelivery(O1, { offered_driver_id: A, offered_at: ago(30 * SEC) });
  mode.beforeDeliveryPatch = () => Object.assign(standing, { status: "assigned", driver_id: B });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "already_taken" });
  assert.equal(deliveryOf(O1)!.driver_id, B);
  ok("accept racing a rival's claim: already_taken, the winner keeps the order");

  // --- no position known: still accepts, writes no coordinates
  reset();
  seedRider(A, "alpha", { last_lat: null, last_lng: null, last_fix_at: null });
  seedOrder(O1);
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  d = deliveryOf(O1)!;
  assert.equal(d.driver_lat, undefined, "no invented position");
  assert.equal(d.distance_km, expectedKm);
  ok("accept with no known position: succeeds, no coordinates invented");

  // --- an order with no drop pin: no distance stored
  reset();
  seedRider(A, "alpha");
  seedOrder(O1, { address: { label: "Home", line: "somewhere" } });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  assert.equal(deliveryOf(O1)!.distance_km, undefined, "no pins, no distance (never a stand-in number)");
  ok("accept an order with no drop pin: succeeds, distance_km not guessed");

  // --- before 0081: the app route fails closed, the web path keeps working
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  mode.missingTables.add("rider_status");
  await assert.rejects(() => jobs.acceptOffer(A, O1, opts), (e: unknown) => status.isRiderSchemaPending(e));
  assert.equal(deliveryOf(O1), undefined);
  assert.deepEqual(await orders.acceptDelivery(A, O1, { windowSeconds: WINDOW, ...routingOpts }), { ok: true }, "the web portal keeps working before 0081");
  ok("without rider_status: the app's accept answers migration_pending; the web accept still works");

  // --- distance_km: the estimate at once, the routed value after the response
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  routing.mode = "ok";
  routeCalls.length = 0;
  let release!: () => void;
  routing.gate = new Promise<void>((r) => (release = r));
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  d = deliveryOf(O1)!;
  assert.equal(d.distance_km, expectedKm, "the straight-line estimate is stored before routing has answered");
  assert.equal(d.distance_source, "estimate");
  release();
  routing.gate = null;
  await settle(() => deliveryOf(O1)!.distance_source === "road");
  d = deliveryOf(O1)!;
  assert.equal(d.distance_km, 4.32, "4321 m -> 4.32 km");
  assert.equal(d.distance_source, "road");
  assert.deepEqual(routeCalls, [ROUTE_URL], "one request, to routing_base_url, lng,lat order");
  ok("accept: the estimate is stored at once ('estimate'), then upgraded to the routed distance ('road') after the response");

  for (const failure of ["error", "abort", "http500", "noroute", "garbage"] as const) {
    reset();
    seedRider(A, "alpha");
    seedOrder(O1);
    routing.mode = failure;
    routeCalls.length = 0;
    assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
    await settle(() => routeCalls.length === 1);
    await sleep(60);
    d = deliveryOf(O1)!;
    assert.equal(routeCalls.length, 1, `${failure}: routing was asked`);
    assert.equal(d.distance_km, expectedKm, `${failure}: the estimate stays`);
    assert.equal(d.distance_source, "estimate", `${failure}: and is labelled as one`);
  }
  ok("accept: routing that times out, errors, answers 500, finds no route or sends garbage leaves the estimate, labelled 'estimate'");

  // a correction made while routing was in flight is not overwritten
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  routing.mode = "ok";
  routing.before = () => {
    deliveryOf(O1)!.distance_km = 9.99;
  };
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  await settle(() => routeCalls.length >= 1);
  await sleep(80);
  routing.before = null;
  assert.equal(deliveryOf(O1)!.distance_km, 9.99);
  assert.equal(deliveryOf(O1)!.distance_source, "estimate", "the upgrade is conditional on the estimate it wrote");
  ok("accept: the routed upgrade never overwrites a distance that changed in the meantime");

  // roadDistanceKm on its own
  routing.mode = "ok";
  routeCalls.length = 0;
  assert.equal(await roadDistanceKm("https://r.test/", SHOP, DROP, { fetch: fakeFetch }), 4.32);
  assert.equal(routeCalls[0], `https://r.test/route/v1/driving/${SHOP.lng},${SHOP.lat};${DROP.lng},${DROP.lat}?overview=false`);
  routeCalls.length = 0;
  assert.equal(await roadDistanceKm("http://insecure.test", SHOP, DROP, { fetch: fakeFetch }), null);
  assert.equal(await roadDistanceKm("", SHOP, DROP, { fetch: fakeFetch }), null);
  assert.equal(routeCalls.length, 0, "a non-https base is never called");
  const hang = (async (_u: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const t0 = Date.now();
  assert.equal(await roadDistanceKm("https://slow.test", SHOP, DROP, { fetch: hang, timeoutMs: 40 }), null);
  assert.ok(Date.now() - t0 < 1000, "a hung server is abandoned at the timeout");
  routing.mode = "error";
  ok("roadDistanceKm: URL, km to 2 dp, https only, and a hung server is abandoned at the timeout");

  // --- 0082 not applied: distance_km is kept, the source column is simply absent
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  routing.mode = "ok";
  mode.missingColumns.add("deliveries.distance_source");
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  await settle(() => deliveryOf(O1)!.distance_km === 4.32);
  d = deliveryOf(O1)!;
  assert.equal(d.distance_km, 4.32, "estimate stored, then upgraded, without the source column");
  assert.equal(d.distance_source, undefined);
  assert.equal(d.driver_location_source, "gps", "the older columns are not dropped with it");
  routing.mode = "error";
  ok("accept without 0082's distance_source: distance_km still stored and upgraded; nothing else dropped");

  // --- a rider who rejected the order cannot take it, open or not
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  t("delivery_events").push({ id: ++eventSeq, delivery_id: "d", order_id: O1, driver_id: A, kind: "rejected", reason: "too_far", created_at: ago(MIN) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: false, error: "rejected" });
  assert.equal(deliveryOf(O1), undefined);
  assert.deepEqual(await jobs.acceptOffer(B, O1, opts), { ok: false, error: "not_online" }, "others are unaffected (B is not online here)");
  ok("accept: a rider who rejected the order is refused ('rejected'), matching their board");

  // --- the previous offeree's ring stops when someone else takes the job
  reset();
  ringStops.length = 0;
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: B, offered_at: ago(200 * SEC) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  await settle(() => ringStops.length > 0);
  assert.deepEqual(ringStops, [[B, O1]]);
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: A, offered_at: ago(10 * SEC) });
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  await sleep(60);
  assert.deepEqual(ringStops, [[B, O1]], "no stop for the accepter themselves, nor when nobody was offered");
  ok("accept: the previous offeree's ring is stopped when a different rider takes the order (and only then)");

  // --- 0081 present but distance_km not granted/known: the write falls back
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedOrder(O2);
  mode.missingColumns.add("deliveries.distance_km");
  assert.deepEqual(await jobs.acceptOffer(A, O1, opts), { ok: true });
  assert.equal(deliveryOf(O1)!.distance_km, undefined);
  assert.equal(deliveryOf(O1)!.driver_id, A);
  assert.equal(deliveryOf(O1)!.driver_location_source, "gps", "the older optional column is not dropped by the newer one's absence");
  seedDelivery(O2, { offered_driver_id: A, offered_at: ago(10 * SEC) });
  assert.deepEqual(await jobs.acceptOffer(A, O2, opts), { ok: true });
  assert.equal(deliveryOf(O2)!.status, "assigned");
  assert.equal(deliveryOf(O2)!.distance_km, undefined);
  ok("accept on a database without 0081's distance_km: succeeds without it (PGRST204 handled on insert and claim)");

  // =========================================================================
  // rejectOffer
  // =========================================================================
  reset();
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedRider(C, "charlie", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.02 });
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: A, offered_at: ago(30 * SEC) });

  assert.deepEqual(await jobs.rejectOffer(A, O1, "because" as never), { ok: false, error: "invalid_reason" });
  assert.deepEqual(await jobs.rejectOffer(B, O1, "too_far"), { ok: false, error: "not_offered" });
  assert.deepEqual(await jobs.rejectOffer(A, "10000000-0000-4000-8000-0000000000ff", "too_far"), { ok: false, error: "not_offered" });
  assert.equal(deliveryOf(O1)!.offered_driver_id, A, "a stranger's reject changes nothing");
  assert.equal(eventsOf(O1, "rejected").length, 0);
  ok("reject: an invalid reason, a rider who is not the offeree and an order with no offer are refused untouched");

  r = await jobs.rejectOffer(A, O1, "too_far");
  assert.deepEqual(r, { ok: true });
  const rej = eventsOf(O1, "rejected");
  assert.equal(rej.length, 1);
  assert.equal(rej[0].driver_id, A);
  assert.equal(rej[0].reason, "too_far");
  assert.equal(rej[0].lat, RIDER_AT.lat, "the rejection is stamped where the rider was");
  d = deliveryOf(O1)!;
  assert.equal(d.status, "unassigned", "a rejection is not a release: still an unassigned row");
  assert.equal(d.driver_id, null);
  assert.equal(d.offered_driver_id, B, "dispatch re-offered it, to the nearest eligible rider but not A");
  assert.ok(eventsOf(O1, "offered").some((e) => e.driver_id === B));
  ok("reject by the offeree: rejected event with reason and position, offer cleared, re-offered to the next rider (not A)");

  // --- the exclusion list is every rejecter and lapser, not just this rejecter
  reset();
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedRider(C, "charlie", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.02 });
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: B, offered_at: ago(30 * SEC) });
  t("delivery_events").push({ id: ++eventSeq, delivery_id: "d", order_id: O1, driver_id: A, kind: "lapsed", created_at: ago(5 * MIN) });
  assert.deepEqual(await jobs.rejectOffer(B, O1, "other", "bike broke"), { ok: true });
  assert.equal(deliveryOf(O1)!.offered_driver_id, C, "A lapsed earlier and B just rejected: C is next");
  assert.equal(eventsOf(O1, "rejected")[0].reason, "other: bike broke");
  ok("reject: re-offer excludes every prior rejecter and lapser; the note is kept with the reason");

  // --- nobody left
  assert.deepEqual(await jobs.rejectOffer(C, O1, "on_break"), { ok: true });
  d = deliveryOf(O1)!;
  assert.equal(d.offered_driver_id, null, "nobody eligible: the offer stays cleared");
  assert.equal(d.status, "unassigned");
  ok("reject when every rider has declined: the order is left open, not re-offered to a decliner");

  // --- and the declined order is not on the decliner's board
  // (covered with the board below)

  // --- before 0081: fail closed, offer untouched
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: A, offered_at: ago(30 * SEC) });
  mode.missingTables.add("delivery_events");
  await assert.rejects(() => jobs.rejectOffer(A, O1, "too_far"), (e: unknown) => status.isRiderSchemaPending(e));
  assert.equal(deliveryOf(O1)!.offered_driver_id, A, "the offer is not cleared when it cannot be recorded");
  ok("reject without delivery_events: migration_pending, and the offer is left as it was");

  // --- the decline history cannot be read: the rejection stands, nothing is re-offered
  reset();
  obsEvents.length = 0;
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: A, offered_at: ago(30 * SEC) });
  mode.failReads.add("delivery_events");
  assert.deepEqual(await jobs.rejectOffer(A, O1, "too_far"), { ok: true });
  mode.failReads.clear();
  assert.equal(eventsOf(O1, "rejected").length, 1, "the rejection is recorded");
  assert.equal(deliveryOf(O1)!.offered_driver_id, null, "the offer is withdrawn and NOT passed on from a partial list");
  for (let i = 0; i < 40 && !obsEvents.some((e) => JSON.stringify(e).includes("reject_history_unreadable")); i++) await sleep(25);
  assert.ok(obsEvents.some((e) => JSON.stringify(e).includes("reject_history_unreadable")), "and the failure is logged");
  ok("reject: an unreadable decline history fails closed (no re-dispatch from a partial exclusion list), and is logged");

  // =========================================================================
  // hasRiderCommitment uses the setting's window
  // =========================================================================
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { offered_driver_id: A, offered_at: ago(150 * SEC) });
  assert.equal(await status.hasRiderCommitment(A, { windowSeconds: 180 }), true);
  assert.equal(await status.hasRiderCommitment(A, { windowSeconds: 120 }), false);
  ok("hasRiderCommitment counts an offer only inside the setting's window (the one dispatch uses)");

  // =========================================================================
  // the sweep: lapsed + never-offered + exclusions
  // =========================================================================
  reset();
  SO1 = SW();
  SO2 = SW();
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedOrder(SO1);
  const lapsed = seedDelivery(SO1, { offered_driver_id: A, offered_at: ago(200 * SEC) });
  t("orders").find((o) => o.id === SO1)!.deliveries = lapsed;
  let n = await sweep.redispatchOrders(Date.now(), WINDOW);
  assert.equal(n, 1);
  const lapsedEv = eventsOf(SO1, "lapsed");
  assert.equal(lapsedEv.length, 1);
  assert.equal(lapsedEv[0].driver_id, A);
  assert.equal(deliveryOf(SO1)!.offered_driver_id, B, "re-offered to B, never back to A");
  ok("sweep: a lapsed offer writes a lapsed event for the rider who let it lapse and re-offers to someone else");

  // a second pass inside B's window does nothing
  t("orders").find((o) => o.id === SO1)!.deliveries = deliveryOf(SO1);
  n = await sweep.redispatchOrders(Date.now(), WINDOW);
  assert.equal(n, 0);
  assert.equal(eventsOf(SO1, "lapsed").length, 1);
  ok("sweep: a second pass inside the new window writes nothing");

  // nobody else eligible: the lapse is recorded once, not once a minute
  reset();
  SO1 = SW();
  SO2 = SW();
  seedRider(A, "alpha");
  seedOrder(SO1);
  const alone = seedDelivery(SO1, { offered_driver_id: A, offered_at: ago(200 * SEC) });
  t("orders").find((o) => o.id === SO1)!.deliveries = alone;
  assert.equal(await sweep.redispatchOrders(Date.now(), WINDOW), 0);
  assert.equal(eventsOf(SO1, "lapsed").length, 1);
  assert.equal(alone.offered_driver_id, null, "cleared: the order is open to the pool");
  assert.equal(await sweep.redispatchOrders(Date.now(), WINDOW), 0);
  assert.equal(eventsOf(SO1, "lapsed").length, 1, "the next minute's pass does not log the same lapse again");
  ok("sweep: with nobody else eligible the lapse is logged once and the order stays open");

  // never offered
  reset();
  SO1 = SW();
  SO2 = SW();
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedOrder(SO1, { ready_at: ago(5 * MIN) });
  seedOrder(SO2, { ready_at: ago(20 * SEC) });
  const never = seedDelivery(SO1, {});
  t("orders").find((o) => o.id === SO1)!.deliveries = never;
  t("delivery_events").push({ id: ++eventSeq, delivery_id: "d", order_id: SO1, driver_id: A, kind: "rejected", reason: "too_far", created_at: ago(3 * MIN) });
  n = await sweep.redispatchOrders(Date.now(), WINDOW);
  assert.equal(n, 1, "SO1 was never offered (a rejection cleared it); SO2 is too fresh");
  assert.equal(deliveryOf(SO1)!.offered_driver_id, B, "A rejected it: never offered back");
  assert.equal(deliveryOf(SO2), undefined, "a freshly ready order is the transition's job");
  ok("sweep: a never-offered ready order is dispatched (excluding earlier rejecters); a fresh one is left to its own dispatch");

  // before 0081 events: the lapse still excludes the rider
  reset();
  SO1 = SW();
  SO2 = SW();
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedOrder(SO1);
  const legacy = seedDelivery(SO1, { offered_driver_id: A, offered_at: ago(200 * SEC) });
  t("orders").find((o) => o.id === SO1)!.deliveries = legacy;
  mode.missingTables.add("delivery_events");
  assert.equal(await sweep.redispatchOrders(Date.now(), WINDOW), 1);
  assert.equal(deliveryOf(SO1)!.offered_driver_id, B);
  ok("sweep without delivery_events: still re-offers, still excluding the rider who let it lapse");

  // a lapse that loses a race is not dispatched
  reset();
  SO1 = SW();
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedRider(C, "charlie", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.02 });
  seedOrder(SO1);
  const raced1 = seedDelivery(SO1, { offered_driver_id: A, offered_at: ago(200 * SEC) });
  t("orders").find((o) => o.id === SO1)!.deliveries = raced1;
  // A concurrent reject -> re-offer lands between the sweep's read and its lapse write.
  mode.beforeDeliveryPatch = () => {
    raced1.offered_driver_id = B;
    raced1.offered_at = new Date().toISOString();
  };
  patchBodies.deliveries = [];
  assert.equal(await sweep.redispatchOrders(Date.now(), WINDOW), 0);
  assert.equal(raced1.offered_driver_id, B, "the newer offer stands");
  assert.equal(eventsOf(SO1, "lapsed").length, 0, "no lapse is recorded for an offer that was already replaced");
  assert.equal(patchBodies.deliveries.length, 1, "and nothing else is written: no dispatch followed the lost race");
  ok("sweep: when the lapse write loses a race the pass does not dispatch over the newer offer");

  // dispatch itself does not overwrite an offer that changed since it read the row
  reset();
  obsEvents.length = 0;
  seedRider(A, "alpha");
  seedRider(B, "bravo", {}, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
  seedOrder(O1);
  const open1 = seedDelivery(O1, {});
  mode.beforeDeliveryPatch = () => {
    open1.offered_driver_id = B;
    open1.offered_at = new Date().toISOString();
  };
  const lost = await dispatch.dispatchOrder(O1, "ready");
  assert.equal(lost.offered, false);
  assert.equal(open1.offered_driver_id, B, "the concurrent offer is left alone");
  assert.equal(eventsOf(O1, "offered").filter((e) => e.driver_id === A).length, 0, "A was never offered it");
  ok("dispatch: the offer write is conditional on the offer it read, so a concurrent re-offer is not overwritten");

  // hopeless orders cannot hog the batch
  reset();
  swSeq += 100;
  seedRider(A, "alpha");
  const hopeless: string[] = [];
  for (let i = 0; i < 25; i++) {
    const id = SW();
    hopeless.push(id);
    const o = seedOrder(id, { ready_at: ago((40 - i) * 1000 + 30 * MIN) });
    o.deliveries = seedDelivery(id, {});
    t("delivery_events").push({ id: ++eventSeq, delivery_id: "d", order_id: id, driver_id: A, kind: "rejected", reason: "too_far", created_at: ago(5 * MIN) });
  }
  const fresh = SW();
  const fo = seedOrder(fresh, { ready_at: ago(5 * MIN) });
  fo.deliveries = seedDelivery(fresh, {});
  assert.equal(await sweep.redispatchOrders(Date.now(), WINDOW), 0, "first pass: the 20-attempt batch is spent on the oldest hopeless orders");
  assert.equal(deliveryOf(fresh)!.offered_driver_id, null);
  assert.equal(await sweep.redispatchOrders(Date.now(), WINDOW), 1, "second pass: those 20 are latched, so the newer order is reached");
  assert.equal(deliveryOf(fresh)!.offered_driver_id, A);
  ok("sweep: an order that cannot be placed is retried once per latch window, so the oldest hopeless orders do not starve newer ones");

  // =========================================================================
  // the presence sweep
  // =========================================================================
  reset();
  const fixOld = ago(25 * MIN);
  seedRider(A, "alpha", { last_fix_at: fixOld, online_since: ago(60 * MIN) });
  seedRider(B, "bravo", { last_fix_at: ago(19 * MIN) });
  seedRider(C, "charlie", { last_fix_at: ago(90 * MIN) });
  t("profiles").push({ id: "d4", full_name: "delta", role: "driver" });
  t("rider_status").push({ driver_id: "d4", is_online: false, last_fix_at: ago(90 * MIN), online_since: null });
  seedDelivery("o-c", { driver_id: C, status: "picked_up" });
  t("rider_shifts").push({ id: ++shiftSeq, driver_id: A, started_at: ago(60 * MIN), ended_at: null });
  t("rider_shifts").push({ id: ++shiftSeq, driver_id: C, started_at: ago(120 * MIN), ended_at: null });
  const count = await sweep.offlineExpiredRiders(new Date());
  assert.equal(count, 1);
  const a = t("rider_status").find((x) => x.driver_id === A)!;
  assert.equal(a.is_online, false);
  assert.equal(a.last_lat, null);
  assert.equal(t("rider_status").find((x) => x.driver_id === B)!.is_online, true, "19 minutes stays");
  assert.equal(t("rider_status").find((x) => x.driver_id === C)!.is_online, true, "a delivery in flight never goes");
  const shiftA = t("rider_shifts").find((s) => s.driver_id === A)!;
  assert.equal(shiftA.ended_by, "presence");
  assert.equal(shiftA.ended_at, fixOld, "the shift ends at the last fix, not at the sweep");
  assert.equal(t("rider_shifts").find((s) => s.driver_id === C)!.ended_at, null);
  ok("presence sweep: 25 min without a fix goes offline (shift closed at the last fix); 19 min and a rider mid-delivery stay");

  // a fix that lands between the read and the write keeps the rider online
  reset();
  seedRider(A, "alpha", { last_fix_at: ago(25 * MIN) });
  t("rider_shifts").push({ id: ++shiftSeq, driver_id: A, started_at: ago(60 * MIN), ended_at: null });
  const row = t("rider_status").find((x) => x.driver_id === A)!;
  mode.failReads.clear();
  // The sweep reads, then (before it writes) the phone reports.
  const realFetch = globalThis.fetch;
  let flipped = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!flipped && (init?.method ?? "GET") === "PATCH" && href.includes("/rider_status")) {
      flipped = true;
      row.last_fix_at = new Date().toISOString();
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const raced = await sweep.offlineExpiredRiders(new Date());
  globalThis.fetch = realFetch;
  assert.equal(raced, 0);
  assert.equal(row.is_online, true, "the rider reported just before the write: they stay online");
  assert.equal(t("rider_shifts")[0].ended_at, null);
  ok("presence sweep: a fix landing between its read and its write keeps the rider online and the shift open");

  // without 0081 the presence sweep is a no-op
  reset();
  mode.missingTables.add("rider_status");
  assert.equal(await sweep.offlineExpiredRiders(new Date()), 0);
  ok("presence sweep without rider_status: nothing to do, no error");

  // =========================================================================
  // dispatch logs when it stands down
  // =========================================================================
  reset();
  obsEvents.length = 0;
  seedRider(A, "alpha");
  seedOrder(O1);
  mode.failReads.add("rider_status");
  const down = await dispatch.dispatchOrder(O1, "ready");
  assert.equal(down.offered, false);
  assert.equal(down.rider, null);
  for (let i = 0; i < 40 && !obsEvents.some((e) => JSON.stringify(e).includes("dispatch_standdown")); i++) await sleep(25);
  const logged = obsEvents.find((e) => JSON.stringify(e).includes("dispatch_standdown"));
  assert.ok(logged, "an unreadable rider_status is reported, not silent");
  assert.equal(logged.level, "error");
  assert.ok(JSON.stringify(logged).includes("rider_status_unreadable"));
  mode.failReads.clear();
  ok("dispatch standing down because rider_status is unreadable is logged (it no longer looks like 'no riders online')");

  obsEvents.length = 0;
  mode.failReads.clear();
  mode.missingTables.add("rider_status");
  const legacyDispatch = await dispatch.dispatchOrder(O1, "ready");
  assert.equal(legacyDispatch.offered, true, "a missing table keeps the legacy behaviour");
  await sleep(150);
  assert.equal(obsEvents.some((e) => JSON.stringify(e).includes("dispatch_standdown")), false, "missing is not an error");
  ok("a missing rider_status table is the legacy path, not a stand-down: nothing logged");

  // =========================================================================
  // reportDriverLocation: the 0026 column on a write that answers PGRST204
  // =========================================================================
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  seedDelivery(O1, { driver_id: A, status: "assigned" });
  mode.missingColumns.add("deliveries.driver_location_source");
  const fixed = await orders.reportDriverLocation(A, RIDER_AT.lat, RIDER_AT.lng);
  assert.deepEqual(fixed, { ok: true, active: true });
  assert.equal(deliveryOf(O1)!.driver_lat, RIDER_AT.lat, "the fix is stored without the column");
  assert.equal(deliveryOf(O1)!.driver_location_source, undefined);
  ok("reportDriverLocation: PGRST204 on driver_location_source retries without it (not only 42703)");

  // =========================================================================
  // the board
  // =========================================================================
  reset();
  seedRider(A, "alpha");
  // Active-less rider A. A reserved ready order, an open one, one held for B, one A rejected,
  // and a heads-up at the kitchen.
  const ids = ["20000000-0000-4000-8000-00000000000" + 1, "20000000-0000-4000-8000-00000000000" + 2, "20000000-0000-4000-8000-00000000000" + 3, "20000000-0000-4000-8000-00000000000" + 4, "20000000-0000-4000-8000-00000000000" + 5];
  const [RES, OPEN, HELD, DECLINED, SOON] = ids;
  const mine = seedOrder(RES, { created_at: ago(20 * MIN) });
  mine.deliveries = seedDelivery(RES, { offered_driver_id: A, offered_at: ago(60 * SEC) });
  seedOrder(OPEN, { created_at: ago(15 * MIN) });
  const held = seedOrder(HELD);
  held.deliveries = seedDelivery(HELD, { offered_driver_id: B, offered_at: ago(60 * SEC) });
  seedOrder(DECLINED);
  t("delivery_events").push({ id: ++eventSeq, delivery_id: "x", order_id: DECLINED, driver_id: A, kind: "rejected", reason: "too_far", created_at: ago(2 * MIN) });
  const soon = seedOrder(SOON, { status: "kitchen", accepted_at: ago(5 * MIN), ready_at: null });
  soon.deliveries = seedDelivery(SOON, { offered_driver_id: A, offered_at: ago(60 * SEC) });

  let board = await jobs.getRiderBoard(A, { ...opts, canCall: true });
  assert.equal(board.offerWindowSeconds, WINDOW);
  assert.equal(board.active, null);
  assert.deepEqual(board.offers.map((o) => o.orderId), [RES, OPEN], "reserved first; held-for-B and declined are hidden");
  const first = board.offers[0];
  assert.equal(first.reservedForYou, true);
  assert.ok(first.offerExpiresAt && Math.abs(Date.parse(first.offerExpiresAt) - (Date.now() - 60 * SEC + WINDOW * SEC)) < 5 * SEC, "expires at offeredAt + the window");
  assert.equal(board.offers[1].reservedForYou, false);
  assert.equal(board.offers[1].offerExpiresAt, null, "an open order has no countdown");
  assert.equal(first.code, `#${RES.slice(0, 8).toUpperCase()}`);
  assert.equal(first.itemCount, 5);
  assert.equal(first.shop.name, "Saffron Kitchen");
  assert.equal(first.shop.phone, null, "the shop's number is only in the active delivery");
  assert.equal(first.drop.phone, null, "the customer's number is only in the active delivery");
  assert.equal(first.instructions, "Gate code 4411");
  assert.deepEqual(first.payment, { instruction: "collect", collectAmount: 350 });
  assert.equal(first.estimatedEarning, null);
  assert.ok(first.shopToDropKm !== null && Math.abs(first.shopToDropKm - Math.round(haversineKm(SHOP, DROP) * 10) / 10) < 0.001);
  assert.ok(first.riderToShopKm !== null && first.riderToShopKm < 0.2);
  assert.ok(typeof first.etaMinutes === "number" && first.etaMinutes > 0);
  assert.equal(board.upcoming.length, 1);
  assert.equal(board.upcoming[0].offer.orderId, SOON);
  assert.ok(board.upcoming[0].readyInMinutes !== null && board.upcoming[0].readyInMinutes >= 14 && board.upcoming[0].readyInMinutes <= 16, "20 min prep, accepted 5 min ago");
  ok("board: reserved offer first with a countdown, open order next; held-for-another and declined hidden; heads-up in upcoming");

  // an offline rider is shown no offers
  t("rider_status").find((x) => x.driver_id === A)!.is_online = false;
  board = await jobs.getRiderBoard(A, { ...opts, canCall: true });
  assert.deepEqual(board.offers, []);
  assert.deepEqual(board.upcoming, []);
  ok("board: an offline rider is shown no offers (a card the server would refuse is worse than none)");
  t("rider_status").find((x) => x.driver_id === A)!.is_online = true;

  // before 0081 the board degrades to empty offers (offline), without throwing
  mode.missingTables.add("rider_status");
  board = await jobs.getRiderBoard(A, { ...opts, canCall: true });
  assert.deepEqual(board.offers, []);
  mode.missingTables.delete("rider_status");
  ok("board without rider_status: reads degrade (offline, no offers) instead of throwing");

  // active delivery
  reset();
  seedRider(A, "alpha");
  seedOrder(O1);
  const act = seedDelivery(O1, {
    driver_id: A,
    status: "assigned",
    assigned_at: ago(5 * MIN),
    arrived_pickup_at: null,
    departed_pickup_at: null,
    arrived_drop_at: null,
    distance_km: 1.9,
  });
  t("profiles").push({ id: "owner-1", full_name: "Owner", role: "vendor", phone: "+910000099999" });
  const stateOf = async (canCall = true) => (await jobs.getRiderBoard(A, { ...opts, canCall })).active!;
  let active = await stateOf();
  assert.equal(active.status, "accepted");
  assert.equal(active.orderId, O1);
  assert.equal(active.deliveryId, act.id);
  assert.equal(active.pickupCodeRequired, true);
  assert.equal(active.distanceKm, 1.9, "the stored route distance wins");
  assert.equal(active.shop.phone, "+910000011111");
  assert.equal(active.drop.phone, "+919999900001");
  assert.equal(active.drop.customerName, "Asha");
  assert.deepEqual(active.items, [{ name: "Paneer", qty: 2 }, { name: "Naan", qty: 3 }]);
  assert.equal(active.instructions, "Gate code 4411");
  assert.equal(active.unreachableWaitMinutes, 10);
  assert.equal(active.podPhotoRequired, false);
  assert.ok(active.timeline.some((e) => e.kind === "accepted") || active.timeline.length === 0);
  act.arrived_pickup_at = ago(MIN);
  assert.equal((await stateOf()).status, "arrived_pickup");
  Object.assign(act, { status: "picked_up", picked_up_at: ago(MIN) });
  active = await stateOf();
  assert.equal(active.status, "picked_up");
  assert.equal(active.pickupCodeRequired, false, "the pickup code gates the pickup leg only");
  act.departed_pickup_at = ago(30 * SEC);
  assert.equal((await stateOf()).status, "on_the_way");
  act.arrived_drop_at = ago(10 * SEC);
  active = await stateOf();
  assert.equal(active.status, "arrived_drop");
  assert.equal(active.arrivedDropAt, act.arrived_drop_at);
  ok("board: the active delivery's status is derived from the stamps (accepted -> arrived_pickup -> picked_up -> on_the_way -> arrived_drop)");

  const noCall = await stateOf(false);
  assert.equal(noCall.shop.phone, null);
  assert.equal(noCall.drop.phone, null);
  ok("board: with driver.call_customer off, neither the shop's nor the customer's number is sent");

  // shop with no phone falls back to the owner's profile
  (t("orders")[0].restaurants as Row).phone = null;
  assert.equal((await stateOf()).shop.phone, "+910000099999");
  ok("board: a shop with no number falls back to the owner's profile phone");

  // exceptions + timeline
  t("delivery_events").push({ id: ++eventSeq, delivery_id: act.id, order_id: O1, driver_id: A, kind: "arrived_pickup", method: null, reason: null, created_at: ago(2 * MIN) });
  t("delivery_exceptions").push({ id: "x1", delivery_id: act.id, order_id: O1, driver_id: A, kind: "complete_without_code", reason: "customer has no phone", status: "approved", decision_note: "ok", created_at: ago(MIN) });
  active = await stateOf();
  assert.ok(active.timeline.some((e) => e.kind === "arrived_pickup"));
  assert.equal(active.exceptions[0].kind, "complete_without_code");
  assert.equal(active.exceptions[0].decisionNote, "ok");
  ok("board: timeline and exceptions are read for the delivery");

  // a database without 0081's columns/tables: the active delivery still loads
  // (A database without 0081 has none of the stamps; the fake does not project
  // columns, so take them off the stored row as well as refusing to select them.)
  for (const k of ["arrived_pickup_at", "departed_pickup_at", "arrived_drop_at", "distance_km"]) delete act[k];
  mode.missingColumns.add("deliveries.arrived_pickup_at");
  mode.missingTables.add("delivery_events");
  mode.missingTables.add("delivery_exceptions");
  active = await stateOf();
  assert.equal(active.status, "picked_up", "status falls back to the delivery's own status");
  assert.equal(active.arrivedDropAt, null);
  assert.equal(active.distanceKm, expectedKm, "no stored distance: the road fallback of the straight line");
  assert.deepEqual(active.timeline, []);
  assert.deepEqual(active.exceptions, []);
  ok("board without 0081/0082: the active delivery degrades (status from deliveries.status, empty timeline) instead of failing");

  // fifty orders held for other riders must not hide the open ones behind them
  reset();
  seedRider(A, "alpha");
  const pad = (n: number) => String(n).padStart(12, "0");
  for (let i = 0; i < 55; i++) {
    const id = `50000000-0000-4000-8000-${pad(i)}`;
    seedOrder(id, { created_at: ago((200 - i) * SEC) });
    seedDelivery(id, { offered_driver_id: B, offered_at: ago(10 * SEC) });
  }
  const openIds: string[] = [];
  for (let i = 55; i < 60; i++) {
    const id = `50000000-0000-4000-8000-${pad(i)}`;
    openIds.push(id);
    seedOrder(id, { created_at: ago((200 - i) * SEC) });
  }
  board = await jobs.getRiderBoard(A, { ...opts, canCall: true });
  assert.deepEqual(board.offers.map((o) => o.orderId), openIds);
  ok("board: held-for-another orders ahead of the open ones do not crowd them out (filtered before any cap)");

  console.log(`PASS rider jobs data layer (${passed} groups)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL", e);
    process.exit(1);
  })
  .finally(() => server.close());
