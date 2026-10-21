/**
 * Dispatch's rider roster (src/lib/dispatch/rider-dispatch.ts `chooseRider`)
 * against a fake in-memory PostgREST. No database, no network beyond localhost.
 *
 *   npm run test:rider-dispatch
 *
 * The pure rule is covered by scripts/qa/rider-dispatch-eligibility.ts; this is
 * the wiring: that `loadCandidates` reads `rider_status`, cuts the roster with
 * it, prefers the newer of the presence fix and the delivery fix for distance,
 * keeps today's behaviour on a database without 0081, and stands down (rather
 * than offering to unchecked riders) when `rider_status` cannot be read.
 */
import http from "node:http";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;

const mode = { missing: false, statusError: false };
let profiles: Row[] = [];
let statusRows: Row[] = [];
let deliveries: Row[] = [];
let riderProfiles: Row[] = [];

/** `eq.x` / `in.(a,b)` / `gte.x` filters on the columns the queries use. */
function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit"].includes(key)) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const arg = raw.slice(dot + 1);
    const value = row[key];
    if (op === "eq") {
      if (String(value) !== arg) return false;
    } else if (op === "neq") {
      if (String(value) === arg) return false;
    } else if (op === "in") {
      const set = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      if (!set.includes(String(value))) return false;
    } else if (op === "gte") {
      if (value === null || value === undefined || String(value) < arg) return false;
    }
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  req.resume();
  req.on("end", () => {
    const table = url.pathname.replace("/rest/v1/", "");
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (table === "profiles") return send(200, profiles.filter((r) => matches(r, url)));
    if (table === "rider_status") {
      if (mode.missing) {
        return send(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
      }
      if (mode.statusError) return send(500, { code: "XX000", message: "boom" });
      return send(200, statusRows.filter((r) => matches(r, url)));
    }
    if (table === "deliveries") return send(200, deliveries.filter((r) => matches(r, url)));
    if (table === "rider_profiles") return send(200, riderProfiles.filter((r) => matches(r, url)));
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`ok   ${name}`);
}

const NOW = Date.parse("2026-10-21T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SHOP = { lat: 21.7157, lng: 81.5335 };
/** Roughly `km` east of the shop (1 degree of longitude is ~103 km at this latitude). */
const east = (km: number) => ({ lat: SHOP.lat, lng: SHOP.lng + km / 103 });

const online = (id: string, fixAgoMs: number, at = east(1), over: Row = {}): Row => ({
  driver_id: id,
  is_online: true,
  break_until: null,
  online_since: ago(3_600_000),
  last_fix_at: ago(fixAgoMs),
  last_lat: at.lat,
  last_lng: at.lng,
  ...over,
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const m = await import("../../src/lib/dispatch/rider-dispatch");
  const choose = (opts: { excludeRiderIds?: string[] } = {}) =>
    m.chooseRider(SHOP, { now: NOW, ...opts });

  profiles = ["alpha", "bravo", "charlie", "delta", "echo"].map((name, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i + 1}`,
    full_name: name,
    role: "driver",
  }));
  const [A, B, C, D, E] = profiles.map((p) => String(p.id));

  // --- with 0081
  statusRows = [
    online(A, 10_000),
    { ...online(B, 10_000), is_online: false, online_since: null, last_fix_at: null },
    // C has no row at all
    online(D, 6 * 60_000),
    online(E, 10_000, east(1), { break_until: new Date(NOW + 600_000).toISOString() }),
  ];
  assert.equal((await choose())?.id, A);
  ok("only the online rider with a fresh fix is offered the order (offline, no row, stale, on break are not)");

  assert.equal(await choose({ excludeRiderIds: [A] }), null);
  ok("when nobody else is eligible there is no rider (the order stays in the open pool)");

  statusRows = [online(A, 10_000, east(3)), online(B, 10_000, east(0.5))];
  assert.equal((await choose())?.id, B);
  ok("among eligible riders the nearest to the shop wins, by the presence position");

  // The presence fix is newer than the delivery row's: it is the position used.
  statusRows = [online(A, 10_000, east(5)), online(B, 10_000, east(2))];
  deliveries = [
    { driver_id: A, status: "delivered", driver_lat: east(0.1).lat, driver_lng: east(0.1).lng, driver_location_at: ago(20 * 60_000) },
  ];
  assert.equal((await choose())?.id, B);
  ok("an older delivery-row fix does not beat a newer presence fix");

  // ...and the delivery row's wins when it is the newer one.
  deliveries = [
    { driver_id: A, status: "assigned", driver_lat: east(0.1).lat, driver_lng: east(0.1).lng, driver_location_at: ago(2_000) },
  ];
  const near = await choose();
  assert.equal(near?.id, B, "A has a delivery in flight: committed riders sort after free ones");
  deliveries = [
    { driver_id: A, status: "delivered", driver_lat: east(0.1).lat, driver_lng: east(0.1).lng, driver_location_at: ago(1_000) },
  ];
  assert.equal((await choose())?.id, A);
  ok("a newer delivery-row fix replaces an older presence fix");
  deliveries = [];

  // --- a database without 0081: today's behaviour
  mode.missing = true;
  statusRows = [];
  const legacy = await choose();
  assert.equal(legacy?.id, A, "every driver profile is a candidate; ties break on name");
  assert.equal((await choose({ excludeRiderIds: [A, B, C, D] }))?.id, E);
  ok("without the rider_status table every driver is still a candidate (dispatch does not go dark before 0081)");

  // --- the table arrives while the process is running: no latch to restart past
  mode.missing = false;
  statusRows = [online(B, 10_000)];
  assert.equal((await choose())?.id, B);
  assert.equal(await choose({ excludeRiderIds: [B] }), null);
  ok("once rider_status exists, eligibility applies at once (no process-lifetime latch on the old behaviour)");

  // --- 0151: a suspended account or a rejected verification is never offered an order
  statusRows = [online(A, 10_000, east(0.5)), online(B, 10_000, east(3))];
  profiles = profiles.map((p) => (p.id === A ? { ...p, account_status: "suspended" } : p));
  assert.equal((await choose())?.id, B, "the nearer rider is suspended");
  profiles = profiles.map((p) => (p.id === A ? { ...p, account_status: "active" } : p));
  riderProfiles = [{ driver_id: A, verification_status: "rejected" }];
  assert.equal((await choose())?.id, B, "the nearer rider's verification was rejected");
  mode.missing = true;
  statusRows = [];
  assert.notEqual((await choose())?.id, A, "...on the path without rider_status too");
  mode.missing = false;
  riderProfiles = [];
  statusRows = [online(B, 10_000)];
  ok("a suspended or rejected rider is never a candidate, with or without rider_status");

  // --- the table cannot be read: stand down, never offer to unchecked riders
  mode.statusError = true;
  await assert.rejects(() => choose());
  mode.statusError = false;
  ok("a rider_status read failure other than 'missing' fails closed (throws; dispatchOrder swallows it)");

  console.log(`PASS rider dispatch roster (${passed} groups)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL", e);
    process.exit(1);
  })
  .finally(() => server.close());
