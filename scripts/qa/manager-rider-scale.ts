/**
 * Manager rider reads at scale: a zone with 1,200 riders (past PostgREST's
 * 1,000-row cap, and twice the 600 the plan asks for) against a fake
 * in-memory PostgREST.
 *
 *   npm run test:manager-rider-scale
 *
 * A PostgREST `in.(…)` filter travels in the URL — about 37 characters per
 * uuid — so a scope's rider list sent that way fails behind any proxy once a
 * town has a few hundred riders, and a bare select quietly stops at 1,000
 * rows. This proves every rider-scoped manager read either filters in the
 * database (the `ops_*_scoped` views' `rider_zone_ids`) or chunks its id
 * lists, and that the scoped rider set is read in full.
 */
import http from "node:http";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;

const URL_LIMIT = 6000; // well inside the 8 KB a proxy commonly accepts
const MAX_ROWS = 1000;
const Z1 = "11111111-1111-4111-8111-111111111111";
const Z2 = "22222222-2222-4222-8222-222222222222";
const RIDERS = 1200;
const NOW = new Date("2026-10-21T10:00:00.000Z");

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const z1Riders = Array.from({ length: RIDERS }, (_, i) => uuid(i + 1));
const z2Riders = Array.from({ length: 10 }, (_, i) => uuid(100000 + i));
const allRiders = [...z1Riders, ...z2Riders];
const zoneOf = (id: string) => (z1Riders.includes(id) ? Z1 : Z2);

const tables: Record<string, Row[]> = {
  staff_zones: allRiders.map((id) => ({ user_id: id, zone_id: zoneOf(id), delivery_zones: { name: "Zone" } })),
  profiles: allRiders.map((id, i) => ({ id, full_name: `Rider ${i}`, phone: "9999999999", role: "driver", account_status: "active", created_at: "2026-01-01T00:00:00Z" })),
  rider_status: allRiders.map((id) => ({ driver_id: id, is_online: true, break_until: null, online_since: NOW.toISOString(), last_lat: 21.7, last_lng: 81.5, last_fix_at: NOW.toISOString() })),
  rider_profiles: allRiders.map((id, i) => ({ driver_id: id, rider_code: `DR-${String(i).padStart(4, "0")}`, created_at: "2026-01-01T00:00:00Z", verification_status: "verified" })),
  deliveries: [],
  orders: [
    {
      id: "99999999-9999-4999-8999-999999999999", status: "ready", restaurant_id: "88888888-8888-4888-8888-888888888888", zone_id: Z1,
      restaurants: { name: "Shop" }, deliveries: [],
    },
  ],
  restaurants: [{ id: "88888888-8888-4888-8888-888888888888", lat: 21.7, lng: 81.5 }],
};
// One deposit, dispute and exception per zone: the Z1 manager must see only theirs.
const scopedView = (base: Row[]) => base.map((r) => ({ ...r, rider_zone_ids: [zoneOf(String(r.driver_id))] }));
tables.ops_cash_deposits_scoped = scopedView([
  { id: uuid(9001), driver_id: z1Riders[5], amount: 500, method: "cash", status: "submitted", created_at: NOW.toISOString() },
  { id: uuid(9002), driver_id: z2Riders[0], amount: 700, method: "cash", status: "submitted", created_at: NOW.toISOString() },
]);
tables.ops_cash_disputes_scoped = scopedView([
  { id: uuid(9101), driver_id: z1Riders[7], day: "2026-10-20", claimed_amount: 100, status: "open", created_at: NOW.toISOString() },
  { id: uuid(9102), driver_id: z2Riders[1], day: "2026-10-20", claimed_amount: 100, status: "open", created_at: NOW.toISOString() },
]);
tables.ops_delivery_exceptions_scoped = scopedView([
  { id: uuid(9201), order_id: uuid(8001), driver_id: z1Riders[9], kind: "wrong_address", status: "pending", created_at: NOW.toISOString() },
  { id: uuid(9202), order_id: uuid(8002), driver_id: z2Riders[2], kind: "wrong_address", status: "pending", created_at: NOW.toISOString() },
]);

const urls: string[] = [];

/** `eq` / `neq` / `in` / `gte` / `lt` / `is` / `ov` on top-level columns; embedded filters are ignored. */
function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(key) || key.includes(".")) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const arg = raw.slice(dot + 1);
    const value = row[key];
    if (op === "eq" && String(value) !== arg) return false;
    if (op === "neq" && String(value) === arg) return false;
    if (op === "in") {
      const set = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      if (!set.includes(String(value))) return false;
    }
    if (op === "gte" && (value == null || String(value) < arg)) return false;
    if (op === "is" && arg === "null" && value != null) return false;
    if (op === "ov") {
      const set = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      if (!Array.isArray(value) || !value.some((v) => set.includes(String(v)))) return false;
    }
  }
  return true;
}

const server = http.createServer((req, res) => {
  urls.push(req.url ?? "");
  const url = new URL(req.url ?? "/", "http://x");
  req.resume();
  req.on("end", () => {
    const path = url.pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("[]");
    }
    const rows = (tables[path] ?? []).filter((r) => matches(r, url));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : MAX_ROWS;
    const page = rows.slice(offset, offset + Math.min(limit, MAX_ROWS));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-range": `${offset}-${offset + page.length - 1}/${rows.length}`,
    };
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? "" : JSON.stringify(page));
  });
});

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`ok   ${name}`);
}

/** Run `fn`, then fail if any request it made was too long for a proxy. */
async function bounded<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const before = urls.length;
  const out = await fn();
  const longest = Math.max(0, ...urls.slice(before).map((u) => u.length));
  assert.ok(longest <= URL_LIMIT, `${name}: a request URL was ${longest} characters (limit ${URL_LIMIT})`);
  ok(`${name}: ${urls.length - before} requests, longest URL ${longest} chars`);
  return out;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const scope = { all: false as const, zoneIds: [Z1] };
  const { scopedRiderIds } = await import("../../src/lib/data-access/scoped-riders");
  const { listCashDeposits, listCashDisputes } = await import("../../src/lib/data-access/manager-cash");
  const { listExceptions } = await import("../../src/lib/data-access/delivery-exceptions");
  const { listRidersForManager } = await import("../../src/lib/data-access/manager-riders");
  const { getLiveSnapshot } = await import("../../src/lib/data-access/manager-live");
  const { parseRiderQuery } = await import("../../src/lib/ops/rider-contract");

  const ids = await bounded("scopedRiderIds", () => scopedRiderIds(scope));
  assert.equal(ids?.size, RIDERS, `the scoped rider set is read in full (got ${ids?.size}, want ${RIDERS})`);
  ok("scoped rider set is complete past the 1,000-row cap");

  const deposits = await bounded("listCashDeposits", () => listCashDeposits(scope, { status: null, rider: null, cursor: null }));
  assert.deepEqual(deposits.items.map((d) => d.id), [uuid(9001)], "only the Z1 rider's deposit");
  assert.ok(urls.some((u) => u.includes("ops_cash_deposits_scoped") && u.includes("rider_zone_ids=ov.")), "deposits filtered by zone in the database");
  ok("deposits scoped in the database");

  const disputes = await bounded("listCashDisputes", () => listCashDisputes(scope, { status: null, cursor: null }));
  assert.deepEqual(disputes.items.map((d) => d.id), [uuid(9101)], "only the Z1 rider's dispute");
  ok("disputes scoped in the database");

  const exceptions = await bounded("listExceptions", () => listExceptions(scope, { status: null, rider: null, cursor: null }, {}));
  assert.deepEqual(exceptions.items.map((e) => e.id), [uuid(9201)], "only the Z1 rider's exception");
  ok("exceptions scoped in the database");

  const parsed = parseRiderQuery(new URLSearchParams());
  assert.ok(parsed.ok);
  const list = await bounded("listRidersForManager", () => listRidersForManager(scope, parsed.query, NOW));
  assert.equal(list.counts.all, RIDERS, "rider counts cover every scoped rider");
  ok("rider list over 1,200 riders");

  const live = await bounded("getLiveSnapshot", () => getLiveSnapshot(scope, NOW));
  assert.equal(live.riders.length, RIDERS, `every online rider in scope is on the map (got ${live.riders.length})`);
  ok("live snapshot carries every online rider in scope");

  const { listRiderCandidates } = await import("../../src/lib/data-access/manager-rider-candidates");
  const candidates = await bounded("listRiderCandidates", () => listRiderCandidates(scope, "99999999-9999-4999-8999-999999999999", NOW));
  assert.equal(candidates?.length, RIDERS, `every rider of the order's zone is a candidate (got ${candidates?.length})`);
  ok("rider candidates cover every rider of the zone");

  console.log(`\n${passed} passed, 0 failed`);
  server.close();
}

main().catch((e) => {
  console.error(`FAIL ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  if (process.env.QA_DEBUG) console.error(urls.slice(-4).map((u) => u.slice(0, 300)).join("\n"));
  server.close();
  process.exit(1);
});
