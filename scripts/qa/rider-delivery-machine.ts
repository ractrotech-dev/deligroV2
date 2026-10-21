/**
 * QA — rider delivery actions: the pure state machine, the data layer against a
 * fake PostgREST, and the route contract.
 *
 *   npm run test:rider-delivery      # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD          a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account without a shop
 *   QA_VENDOR_EMAIL / QA_VENDOR_PASSWORD        a shop owner
 *
 * Three tiers:
 *
 *   1. Pure rules (`lib/rider/delivery-machine.ts`): every legal transition,
 *      the refusals, and the proof-photo truth table. Always run.
 *   2. The data layer (`rider-delivery-actions.ts`, `advanceDelivery`) against
 *      an in-memory PostgREST that emulates the parts of 0081/0082 that matter
 *      here: guard_delivery_transition's rules, log_delivery_event's rows and
 *      the unique client_action_id. Replays, lost races, a cancelled order, the
 *      photo rule, the vendor handover and a database without 0081. Always run.
 *   3. Route contract against the dev server: no cookie is 401 on all four
 *      routes; the session-dependent checks (403 for the wrong role, 400 for a
 *      bad body, 403 for a vendor who does not own the order) need QA accounts,
 *      which this repo has none of — each prints SKIP. SKIP too when the server
 *      is not running.
 *
 * Never sends OTP/SMS/push and never writes data: the fake is the only thing
 * written to, every ONESIGNAL variable is removed before any module loads, and
 * the live requests are unauthenticated or refused by validation first.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

// No push may leave this script, whatever .env.local holds.
for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}
// Rate limits are not exercised here; keep Upstash out of it.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const RIDER_EMAIL = process.env.QA_RIDER_EMAIL ?? "";
const RIDER_PASSWORD = process.env.QA_RIDER_PASSWORD ?? "";
const CUSTOMER_EMAIL = process.env.QA_CUSTOMER_EMAIL ?? "";
const CUSTOMER_PASSWORD = process.env.QA_CUSTOMER_PASSWORD ?? "";
const VENDOR_EMAIL = process.env.QA_VENDOR_EMAIL ?? "";
const VENDOR_PASSWORD = process.env.QA_VENDOR_PASSWORD ?? "";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? "" : `  -> ${JSON.stringify(detail)}`}`);
  }
}

function skip(why: string): void {
  console.log(`SKIP ${why}`);
}

async function group(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// 2. the fake PostgREST (0081/0082 emulated where it matters)
// ---------------------------------------------------------------------------
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const db: Record<string, Row[]> = {};
const storage: Record<string, string[]> = {};
const mode = {
  missingTables: new Set<string>(),
  /** "table.column": a select or filter naming it is 42703, a write naming it is PGRST204. */
  missingColumns: new Set<string>(),
  /** Run once, just before the next PATCH on that table is applied (a race). */
  beforePatch: {} as Record<string, (() => void) | undefined>,
  /** Answer the next PATCH on deliveries with this error, after running the hook. */
  failNextDeliveryPatch: null as null | { code: string; status: number },
  missingBucket: false,
};
const patchBodies: Record<string, Row[]> = {};
let eventSeq = 0;

const t = (name: string): Row[] => (db[name] ??= []);
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(patchBodies)) delete patchBodies[k];
  for (const k of Object.keys(storage)) delete storage[k];
  mode.missingTables.clear();
  mode.missingColumns.clear();
  mode.beforePatch = {};
  mode.failNextDeliveryPatch = null;
  mode.missingBucket = false;
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or", "and"]);

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
      default:
        throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}

const TERMINAL = new Set(["delivered", "failed", "cancelled"]);
const STAMPS = ["arrived_pickup_at", "departed_pickup_at", "arrived_drop_at", "picked_up_at"];

function approved(row: Row, kind: string): boolean {
  return t("delivery_exceptions").some(
    (x) => x.delivery_id === row.id && x.driver_id === row.driver_id && x.status === "approved" && x.kind === kind
  );
}

/** guard_delivery_transition (0082), the rules a rider's write can meet. Mutates `next` (its stamps). */
function guard(old: Row, next: Row): string | null {
  const correction = (next.correction_reason ?? null) !== (old.correction_reason ?? null);
  const moved = next.status !== old.status;
  if (!correction) {
    if (moved && TERMINAL.has(old.status)) return `a ${old.status} delivery cannot become ${next.status}`;
    for (const s of STAMPS) {
      if (old[s] != null && next[s] !== old[s]) return `${s} is already set`;
    }
    if (moved && next.status === "delivered" && !next.picked_up_at) return "delivered requires a pickup";
    if (moved && next.status === "delivered" && old.status !== "picked_up") return "delivered requires picked_up";
  }
  if (moved && next.status === "picked_up" && (old.status !== "assigned" || !next.driver_id)) {
    return "picked_up requires an assigned delivery with a rider";
  }
  if (!correction) {
    if (next.delivery_method === "ops_approved" && next.delivery_method !== old.delivery_method && !approved(next, "complete_without_code")) {
      return "ops_approved requires an approved complete_without_code";
    }
    if (next.pickup_method === "manual" && next.pickup_method !== old.pickup_method && !approved(next, "manual_pickup")) {
      return "manual requires an approved manual_pickup";
    }
  }
  if (moved && next.status === "delivered") next.delivered_at ??= new Date().toISOString();
  if (moved && next.status === "picked_up") next.picked_up_at ??= new Date().toISOString();
  return null;
}

/** log_delivery_event's rows for the rider's steps, with the action id on the first. */
function eventsFor(old: Row, next: Row, actionInSet: boolean): Row[] {
  const out: Row[] = [];
  const add = (kind: string, method: unknown = null) =>
    out.push({
      delivery_id: next.id,
      order_id: next.order_id,
      driver_id: next.driver_id,
      kind,
      method,
      reason: null,
      lat: next.driver_lat ?? null,
      lng: next.driver_lng ?? null,
    });
  if (next.arrived_pickup_at && !old.arrived_pickup_at) add("arrived_pickup");
  if (next.status === "picked_up" && old.status !== "picked_up") add("picked_up", next.pickup_method ?? null);
  if (next.departed_pickup_at && !old.departed_pickup_at) add("departed");
  if (next.arrived_drop_at && !old.arrived_drop_at) add("arrived_drop");
  if (next.status === "delivered" && old.status !== "delivered") add("delivered", next.delivery_method ?? null);
  if (next.status === "cancelled" && old.status !== "cancelled") add("cancelled");
  if (out[0] && actionInSet && next.last_action_id) out[0].client_action_id = next.last_action_id;
  return out;
}

function missingColumnError(table: string, req: http.IncomingMessage, url: URL, body: Row | Row[] | null) {
  for (const entry of mode.missingColumns) {
    const [tbl, col] = entry.split(".");
    if (tbl !== table) continue;
    const word = new RegExp(`(^|[^a-z_])${col}([^a-z_]|$)`);
    const inQuery = word.test(url.searchParams.get("select") ?? "") || [...url.searchParams.keys()].includes(col);
    if (req.method === "GET" && inQuery) {
      return { status: 400, body: { code: "42703", message: `column ${table}.${col} does not exist` } };
    }
    if (req.method !== "GET") {
      const inBody = (Array.isArray(body) ? body : [body ?? {}]).some((r) => col in r);
      if (inBody) {
        return { status: 400, body: { code: "PGRST204", message: `Could not find the '${col}' column of '${table}' in the schema cache` } };
      }
      if ([...url.searchParams.keys()].includes(col)) {
        return { status: 400, body: { code: "42703", message: `column ${table}.${col} does not exist` } };
      }
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };

    // --- storage ---------------------------------------------------------
    if (url.pathname.startsWith("/storage/v1/object/")) {
      const rest = decodeURIComponent(url.pathname.slice("/storage/v1/object/".length));
      const slash = rest.indexOf("/");
      const bucket = slash < 0 ? rest : rest.slice(0, slash);
      if (mode.missingBucket) return send(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      if (req.method === "POST" || req.method === "PUT") {
        (storage[bucket] ??= []).push(rest.slice(slash + 1));
        return send(200, { Key: rest, Id: "obj" });
      }
      if (req.method === "DELETE") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { prefixes?: string[] };
        storage[bucket] = (storage[bucket] ?? []).filter((p) => !(body.prefixes ?? []).includes(p));
        return send(200, []);
      }
      return send(400, { message: "unsupported storage call" });
    }

    const table = url.pathname.replace("/rest/v1/", "");
    const raw = Buffer.concat(chunks).toString();
    const body: Row | Row[] | null = raw ? JSON.parse(raw) : null;
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };

    if (table.startsWith("rpc/")) return send(200, null);
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
    }
    const missing = missingColumnError(table, req, url, body);
    if (missing) return send(missing.status, missing.body);

    if (req.method === "GET") {
      let rows = t(table).filter((r) => matches(r, url));
      const limit = Number(url.searchParams.get("limit"));
      if (limit > 0) rows = rows.slice(0, limit);
      return respond(rows);
    }

    if (req.method === "POST" && body) {
      const incoming = Array.isArray(body) ? body : [body];
      const out: Row[] = [];
      for (const item of incoming) {
        if (table === "delivery_events") {
          if (item.kind === "contact_attempt" && !["customer", "vendor"].includes(item.method)) {
            return send(400, { code: "23514", message: "delivery_events_contact_method_check" });
          }
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
      const hook = mode.beforePatch[table];
      if (hook) {
        mode.beforePatch[table] = undefined;
        hook();
      }
      if (table === "deliveries" && mode.failNextDeliveryPatch) {
        const fail = mode.failNextDeliveryPatch;
        mode.failNextDeliveryPatch = null;
        return send(fail.status, { code: fail.code, message: "forced" });
      }
      const hit = t(table).filter((r) => matches(r, url));
      if (table !== "deliveries") {
        for (const row of hit) Object.assign(row, body);
        return send(200, hit);
      }
      // Statement-level: every row passes the guard and the log, or nothing changes.
      const staged: { row: Row; next: Row; events: Row[] }[] = [];
      for (const row of hit) {
        const next = { ...row, ...body };
        const why = guard(row, next);
        if (why) return send(400, { code: "23514", message: "invalid_delivery_transition", details: why });
        const events = eventsFor(row, next, "last_action_id" in body);
        for (const e of events) {
          if (e.client_action_id && t("delivery_events").some((x) => x.client_action_id === e.client_action_id)) {
            return send(409, { code: "23505", message: "duplicate key value violates unique constraint \"delivery_events_client_action_idx\"" });
          }
        }
        staged.push({ row, next, events });
      }
      for (const s of staged) {
        Object.assign(s.row, s.next);
        for (const e of s.events) {
          t("delivery_events").push({ id: ++eventSeq, created_at: new Date().toISOString(), client_action_id: null, ...e });
        }
      }
      return send(200, staged.map((s) => s.row));
    }

    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const OWNER = "00000000-0000-0000-0000-0000000000f1";
const OTHER_OWNER = "00000000-0000-0000-0000-0000000000f2";
const O1 = "10000000-0000-4000-8000-000000000001";
const DROP = { lat: 21.73, lng: 81.55 };
const AT_DOOR = { lat: 21.7301, lng: 81.5501 };
let actionSeq = 0;
const aid = () => `20000000-0000-4000-8000-${String(++actionSeq).padStart(12, "0")}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function seedOrder(over: Row = {}): Row {
  const row: Row = {
    id: O1,
    status: "ready",
    total: 350,
    payment_method: "cod",
    payment_status: "pending",
    pickup_otp: "1234",
    delivery_otp: "5678",
    address: { label: "Home", line: "12 Lane", lat: DROP.lat, lng: DROP.lng },
    restaurants: { owner_id: OWNER, name: "Saffron Kitchen" },
    ...over,
  };
  t("orders").push(row);
  return row;
}

function seedDelivery(over: Row = {}): Row {
  const row: Row = {
    id: "d1",
    order_id: O1,
    status: "assigned",
    driver_id: A,
    assigned_at: ago(60_000),
    picked_up_at: null,
    delivered_at: null,
    arrived_pickup_at: null,
    departed_pickup_at: null,
    arrived_drop_at: null,
    pickup_method: null,
    delivery_method: null,
    last_action_id: null,
    correction_reason: null,
    pod_photo_path: null,
    cod_collected_amount: null,
    cod_collected_at: null,
    arrival_notified_at: null,
    driver_lat: null,
    driver_lng: null,
    ...over,
  };
  t("deliveries").push(row);
  return row;
}

function seedPeople(): void {
  t("profiles").push({ id: A, full_name: "Ravi Rider", role: "driver" });
  t("profiles").push({ id: B, full_name: "Other Rider", role: "driver" });
}

const delivery = () => t("deliveries").find((d) => d.order_id === O1)!;
const order = () => t("orders").find((o) => o.id === O1)!;
const events = (kind?: string) => t("delivery_events").filter((e) => e.order_id === O1 && (!kind || e.kind === kind));

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

async function pureTier(): Promise<void> {
  const m = await import("../../src/lib/rider/delivery-machine");
  type S = Parameters<typeof m.checkAction>[0];
  const s = (over: Partial<S> = {}): S => ({
    status: "assigned",
    arrivedPickupAt: null,
    departedPickupAt: null,
    arrivedDropAt: null,
    orderStatus: "ready",
    ...over,
  });
  const T = "2026-10-21T10:00:00.000Z";

  await group("every legal transition passes, in order", () => {
    assert.deepEqual(m.checkAction(s(), "arrive_pickup"), { ok: true });
    assert.deepEqual(m.checkAction(s({ orderStatus: "kitchen" }), "arrive_pickup"), { ok: true }, "arriving while the kitchen still cooks");
    assert.deepEqual(m.checkAction(s({ arrivedPickupAt: T }), "pickup"), { ok: true });
    assert.deepEqual(m.checkAction(s(), "pickup"), { ok: true }, "arrival is not a precondition of pickup");
    const carrying = s({ status: "picked_up", arrivedPickupAt: T, orderStatus: "on_the_way" });
    assert.deepEqual(m.checkAction(carrying, "start_trip"), { ok: true });
    assert.deepEqual(m.checkAction({ ...carrying, departedPickupAt: T }, "arrive_drop"), { ok: true });
    assert.deepEqual(m.checkAction(carrying, "arrive_drop"), { ok: true }, "arrive_drop stamps the departure itself");
    assert.deepEqual(m.checkAction({ ...carrying, departedPickupAt: T, arrivedDropAt: T }, "deliver"), { ok: true });
    assert.deepEqual(m.checkAction(carrying, "deliver"), { ok: true }, "the web portal delivers without the stamps");
  });

  await group("deliver from assigned -> bad_state; pickup legs from picked_up -> bad_state", () => {
    assert.deepEqual(m.checkAction(s(), "deliver"), { ok: false, error: "bad_state" });
    assert.deepEqual(m.checkAction(s(), "start_trip"), { ok: false, error: "bad_state" });
    assert.deepEqual(m.checkAction(s(), "arrive_drop"), { ok: false, error: "bad_state" });
    const carrying = s({ status: "picked_up", orderStatus: "on_the_way" });
    assert.deepEqual(m.checkAction(carrying, "arrive_pickup"), { ok: false, error: "bad_state" });
  });

  await group("any action on a cancelled order -> order_not_active (even with its stamp already set)", () => {
    for (const action of m.RIDER_ACTIONS) {
      assert.deepEqual(m.checkAction(s({ orderStatus: "cancelled" }), action), { ok: false, error: "order_not_active" }, action);
      assert.deepEqual(m.checkAction(s({ status: "cancelled", orderStatus: "cancelled" }), action), { ok: false, error: "order_not_active" }, action);
      assert.deepEqual(
        m.checkAction(s({ status: "cancelled", orderStatus: "cancelled", arrivedPickupAt: T, departedPickupAt: T, arrivedDropAt: T }), action),
        { ok: false, error: "order_not_active" },
        `${action} with stamps`
      );
      assert.deepEqual(m.checkAction(s({ status: "failed", orderStatus: "on_the_way" }), action), { ok: false, error: "order_not_active" }, action);
    }
  });

  await group("pickup before the kitchen marks it ready -> order_not_active (the order's own lock)", () => {
    assert.deepEqual(m.checkAction(s({ orderStatus: "kitchen" }), "pickup"), { ok: false, error: "order_not_active" });
    assert.deepEqual(m.checkAction(s({ status: "picked_up", orderStatus: "delivered" }), "start_trip"), { ok: false, error: "order_not_active" });
  });

  await group("a step whose target already holds -> already_done (arrive_pickup twice, deliver twice, ...)", () => {
    assert.deepEqual(m.checkAction(s({ arrivedPickupAt: T }), "arrive_pickup"), { ok: false, error: "already_done" });
    assert.deepEqual(m.checkAction(s({ status: "picked_up", orderStatus: "on_the_way" }), "pickup"), { ok: false, error: "already_done" });
    assert.deepEqual(m.checkAction(s({ status: "picked_up", departedPickupAt: T, orderStatus: "on_the_way" }), "start_trip"), { ok: false, error: "already_done" });
    assert.deepEqual(m.checkAction(s({ status: "picked_up", arrivedDropAt: T, orderStatus: "on_the_way" }), "arrive_drop"), { ok: false, error: "already_done" });
    assert.deepEqual(m.checkAction(s({ status: "delivered", orderStatus: "delivered" }), "deliver"), { ok: false, error: "already_done" });
    assert.deepEqual(m.checkAction(s({ status: "delivered", orderStatus: "delivered" }), "pickup"), { ok: false, error: "already_done" });
  });

  await group("a finished delivery refuses a step it never took -> order_not_active", () => {
    assert.deepEqual(m.checkAction(s({ status: "delivered", orderStatus: "delivered" }), "start_trip"), { ok: false, error: "order_not_active" });
  });

  await group("deliver on an order already marked delivered (the delivery row behind) is allowed: it completes the row", () => {
    assert.deepEqual(m.checkAction(s({ status: "picked_up", orderStatus: "delivered" }), "deliver"), { ok: true });
    assert.deepEqual(m.checkAction(s({ orderStatus: "on_the_way" }), "pickup"), { ok: true }, "order moved, delivery write lost: retry completes it");
  });

  await group("podPhotoRequired truth table: 4 rules x cod/prepaid x via exception", () => {
    const rules = ["never", "cod", "always", "exceptions"] as const;
    const expected: Record<(typeof rules)[number], (cod: boolean, ex: boolean) => boolean> = {
      never: () => false,
      cod: (cod) => cod,
      always: () => true,
      exceptions: (_cod, ex) => ex,
    };
    for (const rule of rules) {
      for (const isCod of [true, false]) {
        for (const viaException of [true, false]) {
          assert.equal(
            m.podPhotoRequired(rule, { isCod, viaException }),
            expected[rule](isCod, viaException),
            `${rule} cod=${isCod} exception=${viaException}`
          );
        }
      }
    }
  });

  await group("checksCode: the code-guess bucket is decided on the normalised method (null = code)", () => {
    // Regression (review fix 1): `method: null` on deliver reached the code
    // check from the 30/min bucket.
    assert.equal(m.checksCode("deliver", null), true, "deliver, method null");
    assert.equal(m.checksCode("deliver", undefined), true);
    assert.equal(m.checksCode("deliver", "code"), true);
    assert.equal(m.checksCode("deliver", "photo"), false);
    assert.equal(m.checksCode("deliver", "ops_approved"), false);
    assert.equal(m.checksCode("deliver", "bogus"), true, "unknown counts as code-checking");
    assert.equal(m.checksCode("pickup", null), true, "pickup, method null");
    assert.equal(m.checksCode("pickup", undefined), true);
    assert.equal(m.checksCode("pickup", "qr"), true);
    assert.equal(m.checksCode("pickup", "manual"), false);
    for (const a of ["arrive_pickup", "start_trip", "arrive_drop", "teleport", null]) {
      assert.equal(m.checksCode(a, null), false, String(a));
    }
    assert.equal(m.isMethodFor("deliver", null), true, "null is accepted as 'no method', i.e. code");
  });

  await group("methods: pickup takes code|qr|manual, deliver takes code|photo|ops_approved", () => {
    assert.deepEqual([...m.PICKUP_METHODS], ["code", "qr", "manual"]);
    assert.deepEqual([...m.DELIVER_METHODS], ["code", "photo", "ops_approved"]);
    assert.equal(m.isMethodFor("pickup", "qr"), true);
    assert.equal(m.isMethodFor("pickup", "photo"), false);
    assert.equal(m.isMethodFor("deliver", "ops_approved"), true);
    assert.equal(m.isMethodFor("deliver", "manual"), false);
    assert.equal(m.isMethodFor("start_trip", undefined), true);
    assert.equal(m.isMethodFor("start_trip", "code"), false);
  });
}

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const actions = await import("../../src/lib/data-access/rider-delivery-actions");
  const orders = await import("../../src/lib/data-access/driver-orders");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");
  const { DEFAULT_SETTINGS } = await import("../../src/lib/settings-defaults");

  const notes: string[] = [];
  const notify = {
    onTheWay: async (orderId: string) => void notes.push(`onTheWay:${orderId}`),
    delivered: async (orderId: string) => void notes.push(`delivered:${orderId}`),
    riderArrived: async (orderId: string, name: string | null) => void notes.push(`arrived:${orderId}:${name}`),
    riderHandedOver: async (driverId: string, orderId: string) => void notes.push(`handedOver:${driverId}:${orderId}`),
  };
  const withRule = (rule: "never" | "cod" | "always" | "exceptions") => ({
    settings: { ...DEFAULT_SETTINGS, podPhotoRule: rule },
    notify,
  });
  const opts = withRule("never");
  const act = (input: Parameters<typeof actions.performDeliveryAction>[2], o = opts, driver = A) =>
    actions.performDeliveryAction(driver, O1, input, o);
  const fresh = (orderOver: Row = {}, deliveryOver: Row = {}) => {
    reset();
    notes.length = 0;
    seedPeople();
    seedOrder(orderOver);
    seedDelivery(deliveryOver);
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  await group("full flow: arrive -> pickup by code -> start trip -> arrive at the door -> deliver by code", async () => {
    fresh();
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid() }), { ok: true });
    assert.ok(delivery().arrived_pickup_at);
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "12-34", method: "code" }), { ok: true });
    assert.equal(delivery().status, "picked_up");
    assert.equal(delivery().pickup_method, "code");
    assert.equal(order().status, "on_the_way");
    assert.deepEqual(await act({ action: "start_trip", actionId: aid() }), { ok: true });
    assert.ok(delivery().departed_pickup_at);
    assert.deepEqual(await act({ action: "arrive_drop", actionId: aid(), lat: AT_DOOR.lat, lng: AT_DOOR.lng }), { ok: true });
    assert.ok(delivery().arrived_drop_at);
    assert.ok(delivery().arrival_notified_at, "the explicit arrival latches the proximity push");
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678", method: "code" }), { ok: true });
    assert.equal(delivery().status, "delivered");
    assert.equal(delivery().delivery_method, "code");
    assert.equal(order().status, "delivered");
    assert.equal(delivery().cod_collected_amount, 350, "COD recorded at the order total");
    assert.ok(delivery().cod_collected_at);
    await settle();
    assert.deepEqual(notes, [`onTheWay:${O1}`, `arrived:${O1}:Ravi Rider`, `delivered:${O1}`]);
    assert.deepEqual(
      events().map((e) => e.kind),
      ["arrived_pickup", "picked_up", "departed", "arrived_drop", "delivered"]
    );
  });

  await group("the action's position is on its event; the action id is on the event and the row", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const id = aid();
    await act({ action: "arrive_drop", actionId: id, lat: AT_DOOR.lat, lng: AT_DOOR.lng });
    const e = events("arrived_drop")[0];
    assert.equal(e.lat, AT_DOOR.lat);
    assert.equal(e.lng, AT_DOOR.lng);
    // One update, two events (departed + arrived_drop): the id goes on the first only.
    assert.deepEqual(events().filter((x) => x.client_action_id === id).map((x) => x.kind), ["departed"]);
    assert.equal(delivery().last_action_id, id);
    assert.ok(events("departed").length === 1, "arrive_drop stamped the departure the rider never tapped");
  });

  await group("an implausible position is not written (the step still happens)", async () => {
    fresh();
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid(), lat: 0, lng: 0 }), { ok: true });
    assert.equal(delivery().driver_lat, null);
  });

  await group("replay: deliver twice with the same action id -> one delivered event, one COD record, duplicate:true", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const id = aid();
    const first = await act({ action: "deliver", actionId: id, code: "5678" });
    const second = await act({ action: "deliver", actionId: id, code: "5678" });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true, duplicate: true });
    assert.equal(events("delivered").length, 1);
    assert.equal((patchBodies.deliveries ?? []).filter((b) => "cod_collected_amount" in b).length, 1);
    await settle();
    assert.deepEqual(notes.filter((n) => n.startsWith("delivered")), [`delivered:${O1}`]);
  });

  await group("replay: two taps of Delivered racing -> both ok, exactly one transition", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const id = aid();
    const [x, y] = await Promise.all([
      act({ action: "deliver", actionId: id, code: "5678" }),
      act({ action: "deliver", actionId: id, code: "5678" }),
    ]);
    assert.ok(x.ok && y.ok, JSON.stringify([x, y]));
    assert.equal([x, y].filter((r) => r.ok && r.duplicate).length, 1);
    assert.equal(events("delivered").length, 1);
    assert.equal((patchBodies.deliveries ?? []).filter((b) => "cod_collected_amount" in b).length, 1);
  });

  await group("replay of each stamp step -> duplicate:true without a write", async () => {
    fresh();
    await act({ action: "arrive_pickup", actionId: aid() });
    const taps = () => (patchBodies.deliveries ?? []).filter((b) => "last_action_id" in b).length;
    const writes = taps();
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid() }), { ok: true, duplicate: true });
    await act({ action: "pickup", actionId: aid(), code: "1234" });
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "0000" }), { ok: true, duplicate: true }, "a replayed pickup is not re-checked against the code");
    await act({ action: "start_trip", actionId: aid() });
    assert.deepEqual(await act({ action: "start_trip", actionId: aid() }), { ok: true, duplicate: true });
    await act({ action: "arrive_drop", actionId: aid() });
    assert.deepEqual(await act({ action: "arrive_drop", actionId: aid() }), { ok: true, duplicate: true });
    assert.equal(events("arrived_pickup").length, 1);
    assert.equal(events("arrived_drop").length, 1);
    assert.equal(taps(), writes + 3, "duplicates never wrote");
    await settle();
    assert.equal(notes.filter((n) => n.startsWith("arrived")).length, 1, "the customer is told once");
  });

  await group("23505 on client_action_id (the tap already produced an event) -> duplicate:true, nothing applied", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const id = aid();
    await act({ action: "start_trip", actionId: id });
    assert.deepEqual(await act({ action: "arrive_drop", actionId: id }), { ok: true, duplicate: true });
    assert.equal(delivery().arrived_drop_at, null, "the statement was rolled back");
  });

  await group("lost race: another device stamped arrival between our read and write -> duplicate:true", async () => {
    fresh();
    mode.beforePatch.deliveries = () => {
      delivery().arrived_pickup_at = new Date().toISOString();
    };
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid() }), { ok: true, duplicate: true });
  });

  await group("a 23514 whose re-read shows the target state -> duplicate:true", async () => {
    fresh();
    mode.beforePatch.deliveries = () => {
      delivery().arrived_pickup_at = new Date().toISOString();
    };
    mode.failNextDeliveryPatch = { code: "23514", status: 400 };
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid() }), { ok: true, duplicate: true });
  });

  await group("a 23514 whose re-read does not show it -> bad_state", async () => {
    fresh();
    mode.failNextDeliveryPatch = { code: "23514", status: 400 };
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid() }), { ok: false, error: "bad_state" });
  });

  await group("cancelled order: every action answers order_not_active and writes nothing", async () => {
    fresh({ status: "cancelled" }, { status: "cancelled" });
    for (const action of ["arrive_pickup", "pickup", "start_trip", "arrive_drop", "deliver"] as const) {
      assert.deepEqual(await act({ action, actionId: aid(), code: "1234" }), { ok: false, error: "order_not_active" }, action);
    }
    assert.equal((patchBodies.deliveries ?? []).length + (patchBodies.orders ?? []).length, 0);
  });

  await group("lost race: the vendor cancels while the rider confirms pickup -> order_not_active, not resurrected", async () => {
    fresh();
    mode.beforePatch.orders = () => {
      order().status = "cancelled";
      delivery().status = "cancelled";
    };
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "1234" }), { ok: false, error: "order_not_active" });
    assert.equal(order().status, "cancelled");
    assert.equal(delivery().status, "cancelled");
  });

  await group("recovery: order moved to on_the_way but the delivery write was lost -> a retry completes the pickup", async () => {
    fresh({ status: "on_the_way" });
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "1234" }), { ok: true });
    assert.equal(delivery().status, "picked_up");
  });

  await group("not yours: another rider's delivery -> not_yours, nothing written", async () => {
    fresh();
    assert.deepEqual(await act({ action: "arrive_pickup", actionId: aid() }, opts, B), { ok: false, error: "not_yours" });
    assert.equal((patchBodies.deliveries ?? []).length, 0);
  });

  await group("codes: wrong pickup code -> bad_pickup_otp, wrong delivery code -> bad_otp, QR checks the same code", async () => {
    fresh();
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "9999" }), { ok: false, error: "bad_pickup_otp" });
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "9999", method: "qr" }), { ok: false, error: "bad_pickup_otp" });
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), code: "1234", method: "qr" }), { ok: true });
    assert.equal(delivery().pickup_method, "qr");
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "0000" }), { ok: false, error: "bad_otp" });
    assert.deepEqual(await act({ action: "deliver", actionId: aid() }), { ok: false, error: "bad_otp" });
  });

  await group("an order with no pickup code: pickup is ungated and recorded as 'none'", async () => {
    fresh({ pickup_otp: null });
    assert.deepEqual(await act({ action: "pickup", actionId: aid() }), { ok: true });
    assert.equal(delivery().pickup_method, "none");
  });

  await group("manual pickup: refused without an approved manual_pickup, accepted with one", async () => {
    fresh();
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), method: "manual" }), { ok: false, error: "manual_not_approved" });
    t("delivery_exceptions").push({ id: "x0", delivery_id: "d1", driver_id: B, kind: "manual_pickup", status: "approved" });
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), method: "manual" }), { ok: false, error: "manual_not_approved" }, "another rider's approval does not count");
    t("delivery_exceptions").push({ id: "x1", delivery_id: "d1", driver_id: A, kind: "manual_pickup", status: "approved" });
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), method: "manual" }), { ok: true });
    assert.equal(delivery().pickup_method, "manual");
  });

  await group("manual pickup: an approval withdrawn between check and write is refused by the guard -> manual_not_approved", async () => {
    fresh();
    t("delivery_exceptions").push({ id: "x1", delivery_id: "d1", driver_id: A, kind: "manual_pickup", status: "approved" });
    mode.beforePatch.deliveries = () => {
      t("delivery_exceptions")[0].status = "rejected";
    };
    assert.deepEqual(await act({ action: "pickup", actionId: aid(), method: "manual" }), { ok: false, error: "manual_not_approved" });
    assert.equal(delivery().status, "assigned");
    assert.equal(order().status, "ready", "the order this call moved to on_the_way is moved back");
  });

  await group("deliver: the guard refuses the delivery write after the order moved -> the order goes back to on_the_way", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    mode.failNextDeliveryPatch = { code: "23514", status: 400 };
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }), { ok: false, error: "bad_state" });
    assert.equal(order().status, "on_the_way");
    assert.equal(delivery().status, "picked_up");
    assert.equal(delivery().cod_collected_amount, null, "no cash recorded for a refused completion");
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }), { ok: true }, "and the retry completes normally");
    assert.equal(order().status, "delivered");
  });

  await group("a rollback never undoes a move somebody else made since", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    mode.beforePatch.deliveries = () => {
      order().status = "cancelled";
    };
    mode.failNextDeliveryPatch = { code: "23514", status: 400 };
    await act({ action: "deliver", actionId: aid(), code: "5678" });
    assert.equal(order().status, "cancelled");
  });

  await group("isCashOrder: one answer for the photo rule and the COD record", () => {
    assert.equal(actions.isCashOrder({ payment_method: "cod", payment_status: "pending" }), true);
    assert.equal(actions.isCashOrder({ payment_method: null }), true, "before 0025 every order was cash");
    assert.equal(actions.isCashOrder(null), true, "unread order: recorded as cash, as the COD record always has");
    assert.equal(actions.isCashOrder({ payment_method: "cod", payment_status: "paid" }), false, "settled: nothing to collect");
    assert.equal(actions.isCashOrder({ payment_method: "online", payment_status: "pending" }), false);
    assert.equal(actions.isCashOrder({ payment_method: "online", payment_status: "paid" }), false);
  });

  await group("manual pickup on a database without delivery_exceptions -> migration pending (503)", async () => {
    fresh();
    mode.missingTables.add("delivery_exceptions");
    let thrown: unknown = null;
    try {
      await act({ action: "pickup", actionId: aid(), method: "manual" });
    } catch (e) {
      thrown = e;
    }
    assert.ok(isRiderSchemaPending(thrown));
  });

  await group("photo rule 'cod': a cash order needs the uploaded photo; the path must be this delivery's", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const o = withRule("cod");
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }, o), { ok: false, error: "photo_required" });
    const up = await actions.uploadDeliveryProof(A, O1, new File([JPEG], "door.jpg", { type: "image/jpeg" }));
    assert.ok(up.ok);
    if (!up.ok) return;
    assert.match(up.path, /^d1\/[0-9a-f-]{36}\.jpg$/);
    assert.equal(delivery().pod_photo_path, up.path);
    assert.deepEqual(storage["delivery-proofs"], [up.path]);
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678", photoPath: "d9/elsewhere.jpg" }, o), { ok: false, error: "photo_required" });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678", photoPath: up.path }, o), { ok: true });
  });

  await group("photo rule 'cod': a prepaid order needs no photo", async () => {
    fresh({ status: "on_the_way", payment_method: "online", payment_status: "paid" }, { status: "picked_up", picked_up_at: ago(60_000) });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }, withRule("cod")), { ok: true });
    assert.equal(delivery().cod_collected_amount, null, "nothing to collect on a paid order");
  });

  await group("photo rule 'always' asks even for prepaid; 'exceptions' only for an ops-approved completion", async () => {
    fresh({ status: "on_the_way", payment_method: "online", payment_status: "paid" }, { status: "picked_up", picked_up_at: ago(60_000) });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }, withRule("always")), { ok: false, error: "photo_required" });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }, withRule("exceptions")), { ok: true });
  });

  await group("ops_approved: refused without an approved complete_without_code; with one, delivered as ops_approved", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), method: "ops_approved" }), { ok: false, error: "bad_state" });
    t("delivery_exceptions").push({ id: "x2", delivery_id: "d1", driver_id: A, kind: "complete_without_code", status: "approved" });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), method: "ops_approved" }, withRule("exceptions")), { ok: false, error: "photo_required" });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), method: "ops_approved" }), { ok: true });
    assert.equal(delivery().delivery_method, "ops_approved");
    assert.equal(delivery().cod_collected_amount, 350);
  });

  await group("photo as the method: refused while the order has a delivery code; with no code, the photo is the proof", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), method: "photo" }), { ok: false, error: "bad_otp" });
    order().delivery_otp = null;
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), method: "photo" }), { ok: false, error: "photo_required" });
    const up = await actions.uploadDeliveryProof(A, O1, new File([PNG], "door.png", { type: "image/png" }));
    assert.ok(up.ok);
    if (!up.ok) return;
    assert.match(up.path, /\.png$/);
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), method: "photo", photoPath: up.path }), { ok: true });
    assert.equal(delivery().delivery_method, "photo");
  });

  await group("completeDelivery (ops path, ruling P2-R1): completes, records COD, notifies; a second call is duplicate", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    t("delivery_exceptions").push({ id: "x3", delivery_id: "d1", driver_id: A, kind: "complete_without_code", status: "approved" });
    const { createAdminClient } = await import("../../src/lib/supabase/admin");
    const supabase = createAdminClient();
    const target = { id: "d1", orderId: O1, driverId: A };
    const first = await actions.completeDelivery(supabase, target, { method: "ops_approved", actorId: OWNER, notify });
    const second = await actions.completeDelivery(supabase, target, { method: "ops_approved", actorId: OWNER, notify });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true, duplicate: true });
    assert.equal(order().status, "delivered");
    assert.equal(delivery().cod_collected_amount, 350);
    assert.equal(events("delivered").length, 1);
  });

  await group("proof upload: type, size, magic bytes, owner, state", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const up = (f: File, driver = A) => actions.uploadDeliveryProof(driver, O1, f);
    assert.deepEqual(await up(new File(["hello"], "a.txt", { type: "text/plain" })), { ok: false, error: "bad_type" });
    assert.deepEqual(await up(new File([PNG], "a.jpg", { type: "image/jpeg" })), { ok: false, error: "bad_type" }, "declared JPEG, bytes PNG");
    assert.deepEqual(await up(new File([new Uint8Array(0)], "a.jpg", { type: "image/jpeg" })), { ok: false, error: "bad_type" });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(JPEG);
    assert.deepEqual(await up(new File([big], "a.jpg", { type: "image/jpeg" })), { ok: false, error: "too_large" });
    assert.deepEqual(await up(new File([JPEG], "a.jpg", { type: "image/jpeg" }), B), { ok: false, error: "not_yours" });
    delivery().status = "assigned";
    assert.deepEqual(await up(new File([JPEG], "a.jpg", { type: "image/jpeg" })), { ok: false, error: "bad_state" });
    assert.equal((storage["delivery-proofs"] ?? []).length, 0, "nothing was stored by a refused upload");
  });

  await group("proof upload: a retake replaces the stored path and removes the old object", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    const one = await actions.uploadDeliveryProof(A, O1, new File([JPEG], "a.jpg", { type: "image/jpeg" }));
    const two = await actions.uploadDeliveryProof(A, O1, new File([JPEG], "b.jpg", { type: "image/jpeg" }));
    assert.ok(one.ok && two.ok);
    if (!one.ok || !two.ok) return;
    assert.equal(delivery().pod_photo_path, two.path);
    await settle();
    assert.deepEqual(storage["delivery-proofs"], [two.path]);
  });

  await group("proof upload without the 0082 column or bucket -> migration pending", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    mode.missingBucket = true;
    let thrown: unknown = null;
    try {
      await actions.uploadDeliveryProof(A, O1, new File([JPEG], "a.jpg", { type: "image/jpeg" }));
    } catch (e) {
      thrown = e;
    }
    assert.ok(isRiderSchemaPending(thrown), "no bucket");
    mode.missingBucket = false;
    mode.missingColumns.add("deliveries.pod_photo_path");
    thrown = null;
    try {
      await actions.uploadDeliveryProof(A, O1, new File([JPEG], "a.jpg", { type: "image/jpeg" }));
    } catch (e) {
      thrown = e;
    }
    assert.ok(isRiderSchemaPending(thrown), "no column");
    await settle();
    assert.equal((storage["delivery-proofs"] ?? []).length, 0, "the orphan is removed");
  });

  await group("contact attempt: a contact_attempt event naming whom; only the rider holding the job", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    assert.deepEqual(await actions.logContactAttempt(A, O1, "customer"), { ok: true });
    const e = events("contact_attempt");
    assert.equal(e.length, 1);
    assert.equal(e[0].method, "customer");
    assert.equal(e[0].driver_id, A);
    assert.equal(e[0].delivery_id, "d1");
    assert.deepEqual(await actions.logContactAttempt(B, O1, "customer"), { ok: false, error: "not_yours" });
    delivery().status = "delivered";
    assert.deepEqual(await actions.logContactAttempt(A, O1, "vendor"), { ok: false, error: "bad_state" });
    assert.equal(events("contact_attempt").length, 1);
  });

  await group("vendor handover: not the owner -> not_yours; no rider -> no_rider; still cooking -> bad_state", async () => {
    fresh({}, { driver_id: null, status: "unassigned" });
    assert.deepEqual(await actions.vendorConfirmHandover(OTHER_OWNER, O1, { notify }), { ok: false, error: "not_yours" });
    assert.deepEqual(await actions.vendorConfirmHandover(OWNER, O1, { notify }), { ok: false, error: "no_rider" });
    fresh({ status: "kitchen" });
    assert.deepEqual(await actions.vendorConfirmHandover(OWNER, O1, { notify }), { ok: false, error: "bad_state" });
    assert.equal(delivery().status, "assigned");
  });

  await group("vendor handover: picked_up by 'vendor', order on_the_way, customer and rider told; a second tap is ok", async () => {
    fresh({}, { arrived_pickup_at: ago(30_000) });
    assert.deepEqual(await actions.vendorConfirmHandover(OWNER, O1, { notify }), { ok: true });
    assert.equal(delivery().status, "picked_up");
    assert.equal(delivery().pickup_method, "vendor");
    assert.equal(order().status, "on_the_way");
    assert.deepEqual(await actions.vendorConfirmHandover(OWNER, O1, { notify }), { ok: true });
    await settle();
    assert.deepEqual(notes, [`onTheWay:${O1}`, `handedOver:${A}:${O1}`]);
    assert.equal(events("picked_up").length, 1);
  });

  await group("advanceDelivery (web portal) delegates: pickup then deliver, same error codes", async () => {
    fresh();
    assert.deepEqual(await orders.advanceDelivery(B, O1, "1234"), { ok: false, error: "not_found" });
    assert.deepEqual(await orders.advanceDelivery(A, O1, "9999"), { ok: false, error: "bad_pickup_otp" });
    assert.deepEqual(await orders.advanceDelivery(A, O1, "1234"), { ok: true });
    assert.equal(delivery().status, "picked_up");
    assert.match(String(delivery().last_action_id), /^[0-9a-f-]{36}$/, "a generated action id");
    assert.deepEqual(await orders.advanceDelivery(A, O1, "0000"), { ok: false, error: "bad_otp" });
    assert.deepEqual(await orders.advanceDelivery(A, O1, "5678"), { ok: true });
    assert.equal(delivery().status, "delivered");
    assert.equal(order().status, "delivered");
    assert.equal(delivery().cod_collected_amount, 350);
    assert.deepEqual(await orders.advanceDelivery(A, O1, "5678"), { ok: false, error: "bad_state" }, "nothing left to advance");
  });

  await group("advanceDelivery on a cancelled order -> order_not_active", async () => {
    fresh({ status: "cancelled" });
    assert.deepEqual(await orders.advanceDelivery(A, O1, "1234"), { ok: false, error: "order_not_active" });
  });

  await group("before 0081: the web pickup and delivery still work; a stamp step is migration pending", async () => {
    fresh();
    for (const col of ["arrived_pickup_at", "departed_pickup_at", "arrived_drop_at", "pickup_method", "delivery_method", "last_action_id", "correction_reason", "pod_photo_path"]) {
      mode.missingColumns.add(`deliveries.${col}`);
      delete delivery()[col];
    }
    let thrown: unknown = null;
    try {
      await act({ action: "arrive_pickup", actionId: aid() });
    } catch (e) {
      thrown = e;
    }
    assert.ok(isRiderSchemaPending(thrown), "arrive_pickup has nowhere to be recorded");
    assert.deepEqual(await orders.advanceDelivery(A, O1, "1234"), { ok: true });
    assert.equal(delivery().status, "picked_up");
    assert.deepEqual(await orders.advanceDelivery(A, O1, "5678"), { ok: true });
    assert.equal(delivery().status, "delivered");
    assert.ok(!("delivery_method" in delivery()), "no 0081 column was written");
  });

  await group("before 0047: no COD columns -> the delivery completes anyway", async () => {
    fresh({ status: "on_the_way" }, { status: "picked_up", picked_up_at: ago(60_000) });
    mode.missingColumns.add("deliveries.cod_collected_amount");
    mode.missingColumns.add("deliveries.cod_collected_at");
    assert.deepEqual(await act({ action: "deliver", actionId: aid(), code: "5678" }), { ok: true });
    assert.equal(delivery().status, "delivered");
  });

  server.close();
}

// ---------------------------------------------------------------------------
// 3. route contract against the dev server
// ---------------------------------------------------------------------------
interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any> | null;
}

async function call(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; form?: FormData } = {}
): Promise<Res> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  let json: Res["json"] = null;
  try {
    json = (await res.json()) as Res["json"];
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function sessionCookie(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** A syntactically valid order id that exists nowhere. */
const NO_SUCH_ORDER = "00000000-0000-4000-8000-000000000000";
const ACTION = `/api/rider/deliveries/${NO_SUCH_ORDER}/action`;
const PROOF = `/api/rider/deliveries/${NO_SUCH_ORDER}/proof`;
const CONTACT = `/api/rider/deliveries/${NO_SUCH_ORDER}/contact`;
const HANDOVER = `/api/vendor/orders/${NO_SUCH_ORDER}/handover`;

async function contract(): Promise<void> {
  try {
    await call("/api/rider/board", { method: "GET" });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }

  const anon: [string, unknown][] = [
    [ACTION, { action: "arrive_pickup", actionId: NO_SUCH_ORDER }],
    [CONTACT, { target: "customer" }],
    [HANDOVER, {}],
  ];
  for (const [path, body] of anon) {
    const res = await call(path, { body });
    check(`no cookie -> 401  POST ${path}`, res.status === 401, res);
  }
  const form = new FormData();
  form.set("file", new File([JPEG], "a.jpg", { type: "image/jpeg" }));
  const proofAnon = await call(PROOF, { form });
  check(`no cookie -> 401  POST ${PROOF}`, proofAnon.status === 401, proofAnon);

  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    for (const [path, body] of anon.slice(0, 2)) {
      const res = await call(path, { body, cookie });
      check(`customer -> 403 not_rider  POST ${path}`, res.status === 403 && res.json?.error === "not_rider", res);
    }
    const res = await call(HANDOVER, { body: {}, cookie });
    check("customer without a shop -> 403 on handover", res.status === 403, res);
  } else {
    skip("customer 403 checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }

  if (VENDOR_EMAIL && VENDOR_PASSWORD) {
    const cookie = await sessionCookie(VENDOR_EMAIL, VENDOR_PASSWORD);
    // The order exists nowhere, so it is certainly not this vendor's.
    const res = await call(HANDOVER, { body: {}, cookie });
    check("vendor who does not own the order -> 403 not_yours on handover", res.status === 403 && res.json?.error === "not_yours", res);
    const bad = await call("/api/vendor/orders/not-a-uuid/handover", { body: {}, cookie });
    check("handover on a non-uuid order -> 400 invalid_order", bad.status === 400 && bad.json?.error === "invalid_order", bad);
  } else {
    skip("vendor checks (403 not_yours for a shop that does not own the order): QA_VENDOR_EMAIL / QA_VENDOR_PASSWORD not set");
  }

  if (!RIDER_EMAIL || !RIDER_PASSWORD) {
    skip("rider checks (400 invalid_order / invalid_action / invalid_action_id / invalid_method / invalid_target / invalid_body, 404 not_found, 503 migration_pending): QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const expect400 = async (name: string, path: string, body: unknown, error: string) => {
    const res = await call(path, { body, cookie });
    check(`${name} -> 400 ${error}`, res.status === 400 && res.json?.error === error, res);
  };
  await expect400("action on a non-uuid order", "/api/rider/deliveries/not-a-uuid/action", { action: "arrive_pickup", actionId: NO_SUCH_ORDER }, "invalid_order");
  await expect400("unknown action", ACTION, { action: "teleport", actionId: NO_SUCH_ORDER }, "invalid_action");
  await expect400("action without an action id", ACTION, { action: "arrive_pickup" }, "invalid_action_id");
  await expect400("pickup by photo", ACTION, { action: "pickup", actionId: NO_SUCH_ORDER, method: "photo" }, "invalid_method");
  await expect400("contact with no target", CONTACT, {}, "invalid_target");
  const noFile = await call(PROOF, { form: new FormData(), cookie });
  check("proof with no file -> 400 invalid_body", noFile.status === 400 && noFile.json?.error === "invalid_body", noFile);

  const gone = await call(ACTION, { body: { action: "arrive_pickup", actionId: NO_SUCH_ORDER }, cookie });
  check(
    "action on an order the rider does not hold -> 404 not_found (or 503 migration_pending before 0081)",
    (gone.status === 404 && gone.json?.error === "not_found") ||
      (gone.status === 503 && gone.json?.error === "migration_pending"),
    gone
  );
}

async function main(): Promise<void> {
  console.log("-- 1. pure rules");
  await pureTier();
  console.log("-- 2. data layer (fake PostgREST)");
  await dataTier();
  console.log("-- 3. route contract");
  await contract();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
