/**
 * Rider availability data layer (src/lib/data-access/rider-status.ts) against a
 * fake in-memory PostgREST. No database, no network beyond localhost.
 *
 *   npm run test:rider-status
 *
 * The module is `server-only`, so tsx runs with the `react-server` condition
 * (the package's own no-op build of that marker). The point of the fake is the
 * failure cases a real database makes hard to stage: a second write failing
 * after the first landed, and a concurrent go-offline between read and write.
 */
import http from "node:http";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;
const mode = {
  missing: false,
  failShiftClose: false,
  flipOfflineBeforeStatusPatch: false,
  /** The rider has a delivery in flight: the deliveries PATCH matches a row. */
  activeDelivery: false,
  failDelivery: false,
  /** The rider_status presence UPDATE fails with a plain database error. */
  failStamp: false,
};
/** Every body the deliveries PATCH was given (the customer-tracking position). */
const deliveryWrites: Row[] = [];
const status = new Map<string, Row>();
const shifts: Row[] = [];

const param = (url: URL, key: string) => url.searchParams.get(key)?.replace(/^eq\./, "") ?? null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | null = raw ? JSON.parse(raw) : null;
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null ? "" : JSON.stringify(obj));
    };
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");

    if (mode.missing && ["rider_status", "rider_shifts", "rider_profiles"].includes(table)) {
      return send(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
    }
    if (table === "deliveries" && req.method === "PATCH" && body) {
      if (mode.failDelivery) return send(500, { code: "XX000", message: "boom" });
      if (!mode.activeDelivery) return send(200, []);
      deliveryWrites.push(body);
      return send(200, [{ id: "d1", order_id: "o1", status: "assigned" }]);
    }
    if (table === "deliveries" || table === "rider_profiles") return send(200, []);

    if (table === "rider_status") {
      const id = param(url, "driver_id") ?? "";
      if (req.method === "GET") {
        const row = status.get(id);
        if (!row) return send(single ? 406 : 200, single ? { code: "PGRST116", message: "0 rows" } : []);
        return send(200, single ? row : [row]);
      }
      if (req.method === "POST" && body) {
        const key = String(body.driver_id);
        status.set(key, { ...(status.get(key) ?? {}), ...body });
        return send(201, null);
      }
      if (req.method === "PATCH" && body) {
        if (mode.flipOfflineBeforeStatusPatch) {
          mode.flipOfflineBeforeStatusPatch = false;
          const current = status.get(id);
          if (current) status.set(id, { ...current, is_online: false, break_until: null });
        }
        if (mode.failStamp && "last_fix_at" in body && body.last_lat !== null) {
          return send(500, { code: "XX000", message: "boom" });
        }
        const row = status.get(id);
        const guard = url.searchParams.get("is_online");
        if (!row || (guard === "eq.true" && !row.is_online)) return send(200, []);
        status.set(id, { ...row, ...body });
        return send(200, [{ driver_id: id }]);
      }
    }

    if (table === "rider_shifts") {
      if (req.method === "POST" && body) {
        if (shifts.some((s) => s.driver_id === body.driver_id && !s.ended_at)) {
          return send(409, { code: "23505", message: "duplicate key" });
        }
        shifts.push({ id: shifts.length + 1, ...body, ended_at: null });
        return send(201, null);
      }
      if (req.method === "GET") {
        const mine = shifts.filter((s) => s.driver_id === param(url, "driver_id") && !s.ended_at);
        return send(200, mine.map((s) => ({ id: s.id, started_at: s.started_at })));
      }
      if (req.method === "PATCH" && body) {
        if (mode.failShiftClose) return send(500, { code: "XX000", message: "boom" });
        for (const s of shifts) {
          if (String(s.id) === param(url, "id") && !s.ended_at) Object.assign(s, body);
        }
        return send(204, null);
      }
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`ok   ${name}`);
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const m = await import("../../src/lib/data-access/rider-status");
  const ID = "00000000-0000-0000-0000-000000000001";
  const FIX = [21.7157, 81.5335] as const;
  const open = () => shifts.filter((s) => !s.ended_at);

  // --- the plain flow
  assert.equal((await m.getRiderAvailability(ID)).isOnline, false);
  assert.equal(await m.getRiderCode(ID), null);
  assert.deepEqual(await m.recordRiderFix(ID, ...FIX), { ok: true, online: false, active: false });
  assert.equal(status.get(ID)?.last_lat, undefined);
  ok("a fix while offline is acknowledged and nothing is kept");
  assert.deepEqual(await m.recordRiderFix(ID, 0, 0), { ok: false, error: "invalid_position" });
  ok("an implausible fix is refused");
  assert.deepEqual(await m.setRiderAvailability(ID, "break", 15), { ok: false, error: "not_online" });

  let r = await m.setRiderAvailability(ID, "online");
  assert.ok(r.ok && r.shift === "open" && shifts.length === 1 && open().length === 1);
  r = await m.setRiderAvailability(ID, "online");
  assert.ok(r.ok && r.shift === "none" && shifts.length === 1);
  ok("online opens one shift; online again opens none");

  assert.deepEqual(await m.recordRiderFix(ID, ...FIX), { ok: true, online: true, active: false });
  assert.equal(status.get(ID)?.last_lat, FIX[0]);
  ok("a fix while online is stamped");

  // --- a fix is two writes (presence, delivery position); each lands on its own
  mode.activeDelivery = true;
  deliveryWrites.length = 0;
  assert.deepEqual(await m.recordRiderFix(ID, ...FIX), { ok: true, online: true, active: true });
  assert.equal(deliveryWrites.length, 1);
  assert.equal(deliveryWrites[0].driver_lat, FIX[0]);
  ok("a fix while online with a delivery in flight stamps presence and moves the delivery");

  // Presence write fails (database error): the delivery position is still written,
  // and the result says presence did not land.
  mode.failStamp = true;
  deliveryWrites.length = 0;
  const partial = await m.recordRiderFix(ID, ...FIX);
  mode.failStamp = false;
  assert.equal(deliveryWrites.length, 1, "the customer's tracking does not wait on presence");
  assert.ok(!partial.ok && partial.error === "presence_failed");
  assert.ok(!partial.ok && partial.error === "presence_failed" && partial.active === true && partial.online === false);
  assert.ok(!partial.ok && partial.error === "presence_failed" && !m.isRiderSchemaPending(partial.cause));
  ok("a failed presence write still writes the delivery position, and reports which part failed");

  // Delivery write fails: presence was stamped and the result says so.
  mode.failDelivery = true;
  const stamped = await m.recordRiderFix(ID, ...FIX);
  mode.failDelivery = false;
  assert.ok(!stamped.ok && stamped.error === "delivery_failed" && stamped.online === true && stamped.active === false);
  ok("a failed delivery write still stamps presence, and reports which part failed");
  mode.activeDelivery = false;

  r = await m.setRiderAvailability(ID, "break", null);
  assert.ok(r.ok);
  assert.equal(new Date(String(status.get(ID)?.break_until)).getUTCFullYear(), 9999);
  assert.equal(status.get(ID)?.last_lat, FIX[0]);
  r = await m.setRiderAvailability(ID, "resume");
  assert.equal(status.get(ID)?.break_until, null);
  ok("break (until resumed) and resume leave the fix alone");

  r = await m.setRiderAvailability(ID, "offline");
  assert.ok(r.ok && r.shift === "close" && open().length === 0);
  assert.equal(status.get(ID)?.last_lat, null);
  assert.equal(shifts[0].ended_by, "rider");
  ok("offline closes the shift and drops the position");

  // --- a half-failed go-offline leaves an orphan; it is never adopted
  await m.setRiderAvailability(ID, "online");
  assert.equal(shifts.length, 2);
  mode.failShiftClose = true;
  await assert.rejects(() => m.setRiderAvailability(ID, "offline"));
  mode.failShiftClose = false;
  assert.equal(status.get(ID)?.is_online, false);
  assert.equal(open().length, 1, "the orphan is open");
  r = await m.setRiderAvailability(ID, "offline");
  assert.ok(r.ok && r.shift === "none");
  assert.equal(open().length, 0);
  assert.equal(shifts[1].ended_by, "presence");
  assert.equal(shifts[1].ended_at, status.get(ID)?.updated_at, "ended when the rider went offline");
  ok("offline while already offline closes the orphan shift at the offline time (a retry finishes the job)");

  await sleep(15);
  await m.setRiderAvailability(ID, "online");
  await sleep(15);
  mode.failShiftClose = true;
  await assert.rejects(() => m.setRiderAvailability(ID, "offline"));
  mode.failShiftClose = false;
  const orphan = open()[0];
  assert.ok(orphan);
  const wentOfflineAt = String(status.get(ID)?.updated_at);
  assert.ok(Date.parse(wentOfflineAt) > Date.parse(String(orphan.started_at)));
  await sleep(40); // the rider stays offline for a while before coming back
  r = await m.setRiderAvailability(ID, "online");
  assert.ok(r.ok && r.shift === "open");
  assert.ok(orphan.ended_at && orphan.ended_by === "presence", "orphan closed, not adopted");
  assert.equal(orphan.ended_at, wentOfflineAt, "ended when the rider went offline, not when they came back");
  assert.ok(Date.parse(String(orphan.ended_at)) < Date.parse(String(open()[0].started_at)));
  assert.equal(open().length, 1);
  assert.notEqual(open()[0], orphan);
  assert.equal(open()[0].started_at, status.get(ID)?.online_since);
  ok("going online closes a stale open shift and starts a new one instead of adopting it");

  // --- unknown or earlier-than-start offline time clamps to the shift's start
  await m.forceRiderOffline(ID, "ops");
  shifts.push({ id: shifts.length + 1, driver_id: ID, started_at: "2026-10-21T10:00:00.000Z", ended_at: null });
  status.set(ID, { ...(status.get(ID) ?? {}), is_online: false, updated_at: "2026-10-21T09:00:00.000Z" });
  await m.setRiderAvailability(ID, "offline");
  const clamped = shifts[shifts.length - 1];
  assert.equal(clamped.ended_at, "2026-10-21T10:00:00.000Z");
  assert.equal(clamped.ended_by, "presence");
  ok("an offline time earlier than the shift's start is clamped to the start (zero length, never negative)");
  await m.setRiderAvailability(ID, "online");

  // --- a break cannot undo a go-offline that landed after the read
  mode.flipOfflineBeforeStatusPatch = true;
  assert.deepEqual(await m.setRiderAvailability(ID, "break", 30), { ok: false, error: "not_online" });
  assert.equal(status.get(ID)?.is_online, false);
  ok("a break racing a go-offline does not bring the rider back online");

  // --- force offline
  await m.setRiderAvailability(ID, "online");
  await m.forceRiderOffline(ID, "logout");
  assert.equal(status.get(ID)?.is_online, false);
  assert.equal(open().length, 0);
  assert.equal(shifts[shifts.length - 1].ended_by, "logout");
  await m.forceRiderOffline("00000000-0000-0000-0000-000000000099", "ops");
  assert.equal(status.has("00000000-0000-0000-0000-000000000099"), false);
  ok("forceRiderOffline ends the shift with its reason and never creates a row");

  assert.deepEqual(await m.getRiderLegalLinks(), { privacyUrl: null, termsUrl: null });
  ok("legal links degrade to null");

  // --- without the 0081 tables
  mode.missing = true;
  assert.equal((await m.getRiderAvailability(ID)).isOnline, false);
  assert.equal(await m.getRiderCode(ID), null);
  for (const fn of [
    () => m.setRiderAvailability(ID, "online"),
    () => m.forceRiderOffline(ID, "logout"),
  ]) {
    await assert.rejects(fn, (e: unknown) => m.isRiderSchemaPending(e));
  }
  ok("without 0081: reads degrade to offline/null, writes throw RiderSchemaPendingError");

  // The customer's live tracking must not depend on 0081.
  mode.activeDelivery = true;
  deliveryWrites.length = 0;
  const pending = await m.recordRiderFix(ID, ...FIX);
  assert.equal(deliveryWrites.length, 1, "the delivery position is written without rider_status");
  assert.ok(!pending.ok && pending.error === "presence_failed" && m.isRiderSchemaPending(pending.cause));
  assert.ok(!pending.ok && pending.error === "presence_failed" && pending.active === true && pending.online === false);
  mode.activeDelivery = false;
  const idle = await m.recordRiderFix(ID, ...FIX);
  assert.ok(!idle.ok && idle.error === "presence_failed" && idle.active === false && m.isRiderSchemaPending(idle.cause));
  ok("without 0081: a fix still moves the delivery; the result says presence is what failed");

  console.log(`PASS rider status data layer (${passed} groups)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL", e);
    process.exit(1);
  })
  .finally(() => server.close());
