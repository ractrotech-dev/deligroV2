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
 * than offering to unchecked riders) when `rider_status` cannot be read —
 * and that `block_dispatch_on_expired_docs` (0086) keeps a rider with an
 * expired document off the roster only when it is on.
 */
import http from "node:http";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;

const mode = { missing: false, statusError: false, docsMissing: true };
let profiles: Row[] = [];
let blockExpired = false;
let docRows: Row[] = [];
let riderProfiles: Row[] = [];
let statusRows: Row[] = [];
let deliveries: Row[] = [];

/** `eq.x` / `in.(a,b)` / `gte.x` filters on the columns the queries use. */
function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit"].includes(key)) continue;
    if (raw.startsWith("not.in.")) {
      const set = raw.slice(8, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      if (set.includes(String(row[key]))) return false;
      continue;
    }
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const arg = raw.slice(dot + 1);
    const value = row[key];
    if (op === "lt") {
      if (value === null || value === undefined || String(value) >= arg) return false;
    } else if (op === "eq") {
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
    // 0086: the setting, and the documents it reads only when it is on.
    if (table === "platform_settings") {
      if (mode.docsMissing) return send(400, { code: "42703", message: "column platform_settings.block_dispatch_on_expired_docs does not exist" });
      return send(200, { block_dispatch_on_expired_docs: blockExpired });
    }
    if (table === "rider_documents") return send(200, docRows.filter((r) => matches(r, url)));
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

  // --- the table cannot be read: stand down, never offer to unchecked riders
  mode.statusError = true;
  await assert.rejects(() => choose());
  mode.statusError = false;
  ok("a rider_status read failure other than 'missing' fails closed (throws; dispatchOrder swallows it)");

  // --- 0086: expired documents (Review Focus 4)
  mode.docsMissing = false;
  statusRows = [online(A, 10_000, east(0.5)), online(B, 10_000, east(3))];
  docRows = [{ driver_id: A, doc_type: "driving_licence", status: "verified", expires_on: "2026-10-01" }];
  riderProfiles = [{ driver_id: A, vehicle_owner: "deligro" }, { driver_id: B, vehicle_owner: "deligro" }];
  blockExpired = false;
  assert.equal((await choose())?.id, A);
  ok("block_dispatch_on_expired_docs off (the default): an expired licence does not keep the nearest rider off");
  blockExpired = true;
  assert.equal((await choose())?.id, B);
  ok("...on: the rider with the expired licence is skipped and the next one offered");
  docRows = [{ driver_id: A, doc_type: "insurance", status: "verified", expires_on: "2026-10-01" }];
  assert.equal((await choose())?.id, A);
  ok("...insurance on Deligro's own bike does not apply, so it does not block");
  blockExpired = false;
  mode.docsMissing = true;

  console.log(`PASS rider dispatch roster (${passed} groups)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL", e);
    process.exit(1);
  })
  .finally(() => server.close());
