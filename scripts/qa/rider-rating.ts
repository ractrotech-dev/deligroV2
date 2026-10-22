/**
 * QA - customers rate their rider (Phase 4 Task 3): the input rules, the data
 * layer against a fake PostgREST, and the route contract.
 *
 *   npm run test:rider-rating   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    a customer account
 *
 * Three tiers:
 *
 *   1. Pure (`lib/rider/rating.ts`): 1-5 whole stars, an optional comment of at
 *      most 300 CHARACTERS (code points, as the table counts them), the status
 *      each refusal answers with. Always run.
 *   2. The data layer (`data-access/rider-rating.ts`) against an in-memory
 *      PostgREST: a customer rates their own delivered order once (a second is
 *      already_rated, from the table's unique key); an undelivered order, someone
 *      else's, a delivery nobody finished and one with no rider are refused with
 *      nothing written; the rider rated is the delivery's, the customer the
 *      session's (Review Focus 3); a database without 0084 fails closed. Always run.
 *   3. Route contract against the dev server: no cookie is 401 on POST and GET;
 *      a signed-in customer's malformed body is 400 and a malformed order id is
 *      403 not_yours. Nothing here can write: the checks stop before the table.
 *      SKIPs without a server or QA accounts (ruling R2: no database has 0084).
 *
 * Never sends push/SMS/OTP and never writes live data.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

for (const key of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_)?ONESIGNAL/i.test(key)) delete process.env[key];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const CUSTOMER_EMAIL = process.env.QA_CUSTOMER_EMAIL ?? "";
const CUSTOMER_PASSWORD = process.env.QA_CUSTOMER_PASSWORD ?? "";

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
    failed++;
    console.log(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CUSTOMER = "00000000-0000-4000-8000-0000000000c2";
const RIDER = "00000000-0000-4000-8000-0000000000d1";
const ATTACKER_RIDER = "00000000-0000-4000-8000-0000000000d9";
const order = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const r = await import("../../src/lib/rider/rating");

  await group("input: whole stars 1-5 only", () => {
    for (const rating of [1, 2, 3, 4, 5]) assert.deepEqual(r.parseRiderRating({ rating }), { ok: true, rating, comment: null });
    for (const bad of [0, 6, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined, true, [5], { n: 5 }]) {
      assert.deepEqual(r.parseRiderRating({ rating: bad }), { ok: false, error: "invalid_rating" }, `rating ${String(bad)}`);
    }
    for (const bad of [null, undefined, "5", 5]) {
      assert.deepEqual(r.parseRiderRating(bad as never), { ok: false, error: "invalid_body" });
    }
  });

  await group("input: the comment is optional, trimmed, and at most 300 characters", () => {
    assert.deepEqual(r.parseRiderRating({ rating: 4, comment: "  Polite and quick  " }), { ok: true, rating: 4, comment: "Polite and quick" });
    assert.deepEqual(r.parseRiderRating({ rating: 4, comment: "   " }), { ok: true, rating: 4, comment: null }, "blank is no comment");
    assert.deepEqual(r.parseRiderRating({ rating: 4, comment: null }), { ok: true, rating: 4, comment: null });
    assert.equal(r.parseRiderRating({ rating: 4, comment: "x".repeat(300) }).ok, true, "300 is allowed");
    assert.deepEqual(r.parseRiderRating({ rating: 4, comment: "x".repeat(301) }), { ok: false, error: "comment_too_long" });
    assert.equal(r.parseRiderRating({ rating: 4, comment: "\u{1F600}".repeat(300) }).ok, true, "300 emoji are 300 characters (600 UTF-16 units)");
    assert.deepEqual(r.parseRiderRating({ rating: 4, comment: "\u{1F600}".repeat(301) }), { ok: false, error: "comment_too_long" });
    assert.equal(r.parseRiderRating({ rating: 4, comment: "नमस्ते ".repeat(40) }).ok, true, "a Hindi comment is a comment (customers write in their own language)");
    assert.deepEqual(r.parseRiderRating({ rating: 4, comment: 12 }), { ok: false, error: "invalid_body" });
    assert.deepEqual(r.parseRiderRating({ rating: 0, comment: "x".repeat(400) }), { ok: false, error: "invalid_rating" }, "the rating is judged first");
  });

  await group("the status each refusal answers with", () => {
    assert.equal(r.ratingErrorStatus("invalid_body"), 400);
    assert.equal(r.ratingErrorStatus("invalid_rating"), 400);
    assert.equal(r.ratingErrorStatus("comment_too_long"), 400);
    assert.equal(r.ratingErrorStatus("not_yours"), 403);
    assert.equal(r.ratingErrorStatus("not_delivered"), 409);
    assert.equal(r.ratingErrorStatus("no_rider"), 409);
    assert.equal(r.ratingErrorStatus("already_rated"), 409);
    assert.equal(r.ratingErrorStatus("migration_pending"), 503);
  });
}

// ---------------------------------------------------------------------------
// 2. data layer against a fake PostgREST
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const mode = { missingTables: new Set<string>(), failReads: new Set<string>() };
const requests: { method: string; table: string; query: string; body: Row | null }[] = [];
const t = (name: string): Row[] => (db[name] ??= []);
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingTables.clear();
  mode.failReads.clear();
  requests.length = 0;
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const arg = raw.slice(dot + 1);
    if (op !== "eq") throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    if (String(row[key]) !== arg) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | null = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method ?? "", table, query: url.search, body });
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    if (table.startsWith("rpc/")) return send(200, null);
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    if (req.method === "GET") {
      if (mode.failReads.has(table)) return send(500, { code: "XX000", message: "boom" });
      const rows = t(table).filter((r) => matches(r, url));
      if (String(req.headers.accept ?? "").includes("vnd.pgrst.object")) {
        return rows.length === 0 ? send(406, { code: "PGRST116", message: "0 rows" }) : send(200, rows[0]);
      }
      return send(200, rows);
    }
    if (req.method === "POST" && body) {
      // The table's unique key on order_id.
      if (table === "rider_ratings" && t(table).some((r) => r.order_id === body.order_id)) {
        return send(409, { code: "23505", message: 'duplicate key value violates unique constraint "rider_ratings_order_id_key"' });
      }
      t(table).push({ ...body });
      return send(201, null);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

function seedOrder(n: number, status: string, customer: string | null, delivery: Row | null): void {
  t("orders").push({ id: order(n), customer_id: customer, status });
  if (delivery) t("deliveries").push({ order_id: order(n), ...delivery });
}

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const x = await import("../../src/lib/data-access/rider-rating");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");
  const writes = () => requests.filter((r) => r.method === "POST" && r.table === "rider_ratings");

  await group("data: a customer rates their own delivered order once", async () => {
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    const first = await x.submitRiderRating(CUSTOMER, order(1), { rating: 5, comment: "  Quick and polite " });
    assert.deepEqual(first, { ok: true, rating: 5, comment: "Quick and polite" });
    assert.equal(t("rider_ratings").length, 1);
    assert.deepEqual(t("rider_ratings")[0], { order_id: order(1), driver_id: RIDER, customer_id: CUSTOMER, rating: 5, comment: "Quick and polite" });
    const second = await x.submitRiderRating(CUSTOMER, order(1), { rating: 1, comment: "changed my mind" });
    assert.deepEqual(second, { ok: false, error: "already_rated" });
    assert.equal(t("rider_ratings").length, 1, "the first rating stands");
    assert.equal(t("rider_ratings")[0].rating, 5);
  });

  await group("data: a rating without a comment stores null", async () => {
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    assert.equal((await x.submitRiderRating(CUSTOMER, order(1), { rating: 3 })).ok, true);
    assert.equal(t("rider_ratings")[0].comment, null);
  });

  await group("data: an undelivered order cannot be rated", async () => {
    reset();
    seedOrder(1, "on_the_way", CUSTOMER, { driver_id: RIDER, status: "picked_up" });
    seedOrder(2, "cancelled", CUSTOMER, { driver_id: RIDER, status: "cancelled" });
    seedOrder(3, "kitchen", CUSTOMER, null);
    for (const n of [1, 2, 3]) {
      assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(n), { rating: 5 }), { ok: false, error: "not_delivered" }, `order ${n}`);
    }
    assert.equal(writes().length, 0, "nothing was written");
  });

  await group("data: someone else's order - and one that does not exist - is not_yours; the rider is never the caller's say-so (Review Focus 3)", async () => {
    reset();
    seedOrder(1, "delivered", OTHER_CUSTOMER, { driver_id: RIDER, status: "delivered" });
    seedOrder(2, "delivered", null, { driver_id: RIDER, status: "delivered" });
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(1), { rating: 5 }), { ok: false, error: "not_yours" });
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(2), { rating: 5 }), { ok: false, error: "not_yours" }, "an order with no customer is nobody's to rate");
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(404), { rating: 5 }), { ok: false, error: "not_yours" });
    assert.equal(writes().length, 0);
    // The body can carry whatever it likes: only rating and comment are read.
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    const sneaky = { rating: 4, comment: "ok", driver_id: ATTACKER_RIDER, customer_id: OTHER_CUSTOMER, driverId: ATTACKER_RIDER };
    assert.equal((await x.submitRiderRating(CUSTOMER, order(1), sneaky)).ok, true);
    assert.equal(t("rider_ratings")[0].driver_id, RIDER, "the delivery's rider");
    assert.equal(t("rider_ratings")[0].customer_id, CUSTOMER, "the session's customer");
  });

  await group("data: a delivery nobody finished, or with no rider, has nobody to rate", async () => {
    reset();
    // Staff marked the order delivered while the rider's delivery is still open.
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "picked_up" });
    seedOrder(2, "delivered", CUSTOMER, { driver_id: null, status: "delivered" });
    seedOrder(3, "delivered", CUSTOMER, null);
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(1), { rating: 5 }), { ok: false, error: "not_delivered" });
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(2), { rating: 5 }), { ok: false, error: "no_rider" });
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(3), { rating: 5 }), { ok: false, error: "no_rider" });
    assert.equal(writes().length, 0);
  });

  await group("data: bad input is refused before the database is touched", async () => {
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    for (const rating of [0, 6, 2.5, "5", null]) {
      assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(1), { rating }), { ok: false, error: "invalid_rating" });
    }
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(1), { rating: 5, comment: "x".repeat(301) }), { ok: false, error: "comment_too_long" });
    assert.deepEqual(await x.submitRiderRating(CUSTOMER, order(1), null), { ok: false, error: "invalid_body" });
    assert.equal(requests.length, 0, "no request reached PostgREST");
    assert.equal((await x.submitRiderRating(CUSTOMER, order(1), { rating: 5, comment: "x".repeat(300) })).ok, true);
  });

  await group("data: the customer reads back only their own rating", async () => {
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    seedOrder(2, "delivered", OTHER_CUSTOMER, { driver_id: RIDER, status: "delivered" });
    await x.submitRiderRating(CUSTOMER, order(1), { rating: 4, comment: "Good" });
    await x.submitRiderRating(OTHER_CUSTOMER, order(2), { rating: 1, comment: "Bad" });
    assert.deepEqual(await x.getOwnRiderRating(CUSTOMER, order(1)), { rating: 4, comment: "Good" });
    assert.deepEqual(await x.getOwnRiderRating(CUSTOMER, order(2)), { rating: null, comment: null }, "another customer's rating is not returned");
    assert.deepEqual(await x.getOwnRiderRating(CUSTOMER, order(404)), { rating: null, comment: null });
    const reads = requests.filter((r) => r.method === "GET" && r.table === "rider_ratings");
    assert.ok(reads.every((r) => r.query.includes(`customer_id=eq.${CUSTOMER}`) || r.query.includes(`customer_id=eq.${OTHER_CUSTOMER}`)), "every read is keyed on the caller");
    assert.ok(reads.every((r) => /select=rating%2Ccomment|select=rating,comment/.test(r.query)), "only rating and comment are selected");
  });

  await group("data: before 0084 a rating fails closed (503 migration_pending) and reading finds none", async () => {
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    mode.missingTables.add("rider_ratings");
    let caught: unknown = null;
    try {
      await x.submitRiderRating(CUSTOMER, order(1), { rating: 5 });
    } catch (e) {
      caught = e;
    }
    assert.ok(isRiderSchemaPending(caught), String(caught));
    assert.deepEqual(await x.getOwnRiderRating(CUSTOMER, order(1)), { rating: null, comment: null });
    reset();
    seedOrder(1, "delivered", CUSTOMER, { driver_id: RIDER, status: "delivered" });
    mode.failReads.add("deliveries");
    await assert.rejects(x.submitRiderRating(CUSTOMER, order(1), { rating: 5 }), (e: unknown) => !isRiderSchemaPending(e), "any other failure is a plain error (500)");
  });
}

// ---------------------------------------------------------------------------
// 3. the route contract (needs `npm run dev`)
// ---------------------------------------------------------------------------
const SOME_ORDER = "00000000-0000-4000-8000-00000000abcd";

async function call(path: string, method: "GET" | "POST", cookie?: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  let json: Row | null = null;
  try {
    json = (await res.json()) as Row;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function sessionCookie(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    isSingleton: false,
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

async function contract(): Promise<void> {
  try {
    await fetch(`${BASE}/api/rider/me`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }
  const path = `/api/orders/${SOME_ORDER}/rider-rating`;
  const post = await call(path, "POST", undefined, { rating: 5 });
  check(`no cookie -> 401  POST ${path}`, post.status === 401 && post.json?.error === "unauthorized", post);
  const get = await call(path, "GET");
  check(`no cookie -> 401  GET ${path}`, get.status === 401 && get.json?.error === "unauthorized", get);

  if (!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD) {
    skip("customer checks (400 invalid_rating / invalid_body / comment_too_long, 403 not_yours, GET nulls): QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
  const expect = async (name: string, status: number, error: string, p: string, body: unknown) => {
    const res = await call(p, "POST", cookie, body);
    check(`${name} -> ${status} ${error}`, res.status === status && res.json?.error === error, res);
  };
  // Every one of these is refused before the database is asked anything: nothing is written.
  await expect("rating 0", 400, "invalid_rating", path, { rating: 0 });
  await expect("rating 6", 400, "invalid_rating", path, { rating: 6 });
  await expect("rating '5'", 400, "invalid_rating", path, { rating: "5" });
  await expect("comment of 301 characters", 400, "comment_too_long", path, { rating: 5, comment: "x".repeat(301) });
  await expect("comment that is a number", 400, "invalid_body", path, { rating: 5, comment: 7 });
  await expect("body that is not JSON", 400, "invalid_body", path, "{nope");
  await expect("an order id that is not an id", 403, "not_yours", "/api/orders/not-an-id/rider-rating", { rating: 5 });
  const mine = await call(path, "GET", cookie);
  check(`GET ${path} for an order that is not theirs -> 200 nulls`, mine.status === 200 && mine.json?.rating === null && mine.json?.comment === null, mine);
}

async function main(): Promise<void> {
  console.log("-- 1. input rules");
  await pureTier();
  console.log("-- 2. data layer (fake PostgREST)");
  await dataTier();
  console.log("-- 3. route contract");
  await contract();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
