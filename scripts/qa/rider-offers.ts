/**
 * QA — rider offers: the pure rules, the sweep's selectors and the route contract.
 *
 *   npm run test:rider-offers          # tsx; the contract part needs `npm run dev` (port 3005)
 *
 *   BASE                                        default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD          a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account
 *
 * Three tiers:
 *
 *   1. Pure rules (`lib/rider/offer-window.ts`) and the sweep's row selectors
 *      (`lib/dispatch/sweep-select.ts`): no server, no database. Always run.
 *   2. Route contract against the dev server: no cookie is 401 on all three
 *      routes. Needs only the server (SKIP when it is not running).
 *   3. Session-dependent checks (403 for a customer, 400 invalid_reason /
 *      invalid_order for a rider, the 503 migration_pending contract on a
 *      database without 0081/0082): need QA accounts, which this repo has none
 *      of — each prints SKIP rather than failing. The data layer itself
 *      (accept, reject, the sweep) is covered against a fake PostgREST by
 *      `scripts/qa/rider-jobs.ts`.
 *
 * Never sends OTP/SMS/push and never writes data: the only requests are
 * unauthenticated (refused before anything is touched) or, with QA accounts,
 * rejected by validation before any table is read.
 */
import assert from "node:assert/strict";
import { createBrowserClient } from "@supabase/ssr";

import {
  OFFER_WINDOW_DEFAULT_SECONDS,
  REJECT_REASONS,
  isRejectReason,
  normalizeOfferWindow,
  offerDeadline,
  offerState,
  roadKmFallback,
} from "../../src/lib/rider/offer-window";
import {
  PRESENCE_TIMEOUT_MS,
  presenceExpired,
  redispatchTargets,
  type PresenceRow,
  type RedispatchRow,
} from "../../src/lib/dispatch/sweep-select";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

const BASE = (process.env.BASE ?? "http://localhost:3005").replace(/\/$/, "");
const RIDER_EMAIL = process.env.QA_RIDER_EMAIL ?? "";
const RIDER_PASSWORD = process.env.QA_RIDER_PASSWORD ?? "";
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

/** Run an assertion-style block as one named check. */
function group(name: string, fn: () => void): void {
  try {
    fn();
    check(name, true);
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// 1a. offer-window.ts
// ---------------------------------------------------------------------------
const T0 = "2026-10-21T10:00:00.000Z";
const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms);
const ME = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";

group("offerDeadline is offeredAt + the window (not a constant)", () => {
  assert.equal(offerDeadline(T0, 180), "2026-10-21T10:03:00.000Z");
  assert.equal(offerDeadline(T0, 60), "2026-10-21T10:01:00.000Z");
  assert.equal(offerDeadline(T0, 600), "2026-10-21T10:10:00.000Z");
});

group("offerDeadline is null without a usable offeredAt", () => {
  assert.equal(offerDeadline(null, 180), null);
  assert.equal(offerDeadline("not a date", 180), null);
});

group("offerState: mine inside the window, open from its last second on", () => {
  const offer = { offeredDriverId: ME, offeredAt: T0 };
  assert.equal(offerState(ME, offer, 180, at(T0, 179_000)), "mine");
  assert.equal(offerState(ME, offer, 180, at(T0, 181_000)), "open");
  assert.equal(offerState(ME, offer, 180, at(T0, 180_000)), "open", "the deadline itself is open");
});

group("offerState: held for somebody else inside the window, open after it", () => {
  const offer = { offeredDriverId: OTHER, offeredAt: T0 };
  assert.equal(offerState(ME, offer, 180, at(T0, 179_000)), "held");
  assert.equal(offerState(ME, offer, 180, at(T0, 181_000)), "open");
});

group("offerState follows the window it is given", () => {
  const offer = { offeredDriverId: ME, offeredAt: T0 };
  assert.equal(offerState(ME, offer, 60, at(T0, 61_000)), "open");
  assert.equal(offerState(ME, offer, 600, at(T0, 599_000)), "mine");
  assert.equal(offerState(ME, offer, 600, at(T0, 601_000)), "open");
});

group("offerState: no offer, or an offer with no timestamp, is open (never strands an order)", () => {
  assert.equal(offerState(ME, { offeredDriverId: null, offeredAt: null }, 180, new Date(T0)), "open");
  assert.equal(offerState(ME, { offeredDriverId: OTHER, offeredAt: null }, 180, new Date(T0)), "open");
  assert.equal(offerState(ME, { offeredDriverId: OTHER, offeredAt: "garbage" }, 180, new Date(T0)), "open");
});

group("normalizeOfferWindow clamps to 60-600 s and falls back to 180", () => {
  assert.equal(OFFER_WINDOW_DEFAULT_SECONDS, 180);
  assert.equal(normalizeOfferWindow(180), 180);
  assert.equal(normalizeOfferWindow(30), 60);
  assert.equal(normalizeOfferWindow(9999), 600);
  assert.equal(normalizeOfferWindow(Number.NaN), 180);
  assert.equal(normalizeOfferWindow(undefined), 180);
  assert.equal(normalizeOfferWindow("120"), 120);
  assert.equal(normalizeOfferWindow(null), 180);
});

group("roadKmFallback is straight line x 1.3 to 2 dp", () => {
  assert.equal(roadKmFallback(10), 13);
  assert.equal(roadKmFallback(0), 0);
  assert.equal(roadKmFallback(3.333), 4.33);
  assert.equal(roadKmFallback(1), 1.3);
});

group("reject reasons are exactly the five the brief lists, in order", () => {
  assert.deepEqual([...REJECT_REASONS], ["too_far", "vehicle_issue", "on_break", "low_battery", "other"]);
  assert.equal(isRejectReason("too_far"), true);
  assert.equal(isRejectReason("because"), false);
  assert.equal(isRejectReason(undefined), false);
  assert.equal(isRejectReason(null), false);
  assert.equal(isRejectReason(42), false);
});

// ---------------------------------------------------------------------------
// 1b. the sweep's selectors
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-21T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

const rider = (over: Partial<PresenceRow> = {}): PresenceRow => ({
  driverId: ME,
  isOnline: true,
  lastFixAt: ago(5 * MIN),
  onlineSince: ago(60 * MIN),
  hasActiveDelivery: false,
  ...over,
});

group("presenceExpired: 19:59 without a fix stays, 20:01 goes, 20:00 goes", () => {
  assert.equal(PRESENCE_TIMEOUT_MS, 20 * MIN);
  assert.deepEqual(presenceExpired([rider({ lastFixAt: ago(19 * MIN + 59_000) })], NOW), []);
  const gone = presenceExpired([rider({ lastFixAt: ago(20 * MIN + 1_000) })], NOW);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].driverId, ME);
  assert.equal(presenceExpired([rider({ lastFixAt: ago(20 * MIN) })], NOW).length, 1);
});

group("presenceExpired: the shift ends at the last fix", () => {
  const fix = ago(25 * MIN);
  const [gone] = presenceExpired([rider({ lastFixAt: fix })], NOW);
  assert.equal(gone.endedAt, fix);
});

group("presenceExpired: with no fix ever, it counts from online_since and ends there", () => {
  const since = ago(21 * MIN);
  const [gone] = presenceExpired([rider({ lastFixAt: null, onlineSince: since })], NOW);
  assert.equal(gone.endedAt, since);
  assert.deepEqual(presenceExpired([rider({ lastFixAt: null, onlineSince: ago(19 * MIN) })], NOW), []);
});

group("presenceExpired: a delivery in flight never goes, nor does an offline rider", () => {
  assert.deepEqual(presenceExpired([rider({ lastFixAt: ago(90 * MIN), hasActiveDelivery: true })], NOW), []);
  assert.deepEqual(presenceExpired([rider({ isOnline: false, lastFixAt: ago(90 * MIN) })], NOW), []);
});

group("presenceExpired: an online row with no timestamps at all is taken offline (nothing proves presence)", () => {
  const [gone] = presenceExpired([rider({ lastFixAt: null, onlineSince: null })], NOW);
  assert.equal(gone.driverId, ME);
  assert.equal(gone.endedAt, null);
});

group("presenceExpired: a fix from the future does not keep a rider alive forever", () => {
  // A clock-skewed phone: the fix is "ahead" of now by an hour. Age is |now - fix|.
  assert.equal(presenceExpired([rider({ lastFixAt: new Date(NOW.getTime() + 60 * MIN).toISOString() })], NOW).length, 1);
});

const WINDOW = 180;
const order = (over: Partial<RedispatchRow> = {}): RedispatchRow => ({
  orderId: "o1",
  orderStatus: "ready",
  readyAt: ago(10 * MIN),
  deliveryStatus: "unassigned",
  offeredDriverId: ME,
  offeredAt: ago(200_000),
  ...over,
});

group("redispatchTargets: a lapsed offer on a ready order is re-offered, naming who let it lapse", () => {
  const [t] = redispatchTargets([order()], NOW, WINDOW);
  assert.equal(t.orderId, "o1");
  assert.equal(t.kind, "lapsed");
  assert.equal(t.lapsedDriverId, ME);
});

group("redispatchTargets: an offer still inside the (setting's) window is left alone", () => {
  assert.deepEqual(redispatchTargets([order({ offeredAt: ago(170_000) })], NOW, WINDOW), []);
  // The same age is lapsed under a shorter window: the setting is what counts.
  assert.equal(redispatchTargets([order({ offeredAt: ago(170_000) })], NOW, 120).length, 1);
});

group("redispatchTargets: a never-offered ready order (unassigned, nobody offered) is picked up", () => {
  const [t] = redispatchTargets([order({ offeredDriverId: null, offeredAt: null })], NOW, WINDOW);
  assert.equal(t.kind, "never_offered");
  assert.equal(t.lapsedDriverId, null);
});

group("redispatchTargets: a ready order with no delivery row at all is never-offered too", () => {
  const [t] = redispatchTargets([order({ deliveryStatus: null, offeredDriverId: null, offeredAt: null })], NOW, WINDOW);
  assert.equal(t.kind, "never_offered");
});

group("redispatchTargets: a freshly ready order is given a minute (the ready transition dispatches itself)", () => {
  const fresh = order({ offeredDriverId: null, offeredAt: null, readyAt: ago(30_000) });
  assert.deepEqual(redispatchTargets([fresh], NOW, WINDOW), []);
  assert.equal(redispatchTargets([{ ...fresh, readyAt: ago(61_000) }], NOW, WINDOW).length, 1);
});

group("redispatchTargets: only ready orders, only unassigned deliveries", () => {
  assert.deepEqual(redispatchTargets([order({ orderStatus: "kitchen" })], NOW, WINDOW), []);
  assert.deepEqual(redispatchTargets([order({ orderStatus: "cancelled" })], NOW, WINDOW), []);
  for (const status of ["assigned", "picked_up", "delivered", "failed", "cancelled"]) {
    assert.deepEqual(
      redispatchTargets([order({ deliveryStatus: status })], NOW, WINDOW),
      [],
      `${status} is somebody's, or over`
    );
  }
});

group("redispatchTargets: an offer with no timestamp cannot be measured, so it is re-offered", () => {
  const [t] = redispatchTargets([order({ offeredAt: null })], NOW, WINDOW);
  assert.equal(t.kind, "lapsed");
});

group("redispatchTargets keeps row order and picks the right rows from a mixed batch", () => {
  const rows = [
    order({ orderId: "a" }),
    order({ orderId: "b", offeredAt: ago(10_000) }),
    order({ orderId: "c", offeredDriverId: null, offeredAt: null }),
    order({ orderId: "d", deliveryStatus: "assigned" }),
  ];
  assert.deepEqual(redispatchTargets(rows, NOW, WINDOW).map((t) => t.orderId), ["a", "c"]);
});

// ---------------------------------------------------------------------------
// 2 + 3. route contract against the dev server
// ---------------------------------------------------------------------------
interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any> | null;
}

async function call(
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {}
): Promise<Res> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
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

/** A syntactically valid order id that exists nowhere: validation and auth run before any lookup. */
const NO_SUCH_ORDER = "00000000-0000-4000-8000-000000000000";

const ROUTES: { path: string; method: string; body?: unknown }[] = [
  { path: "/api/rider/board", method: "GET" },
  { path: `/api/rider/offers/${NO_SUCH_ORDER}/accept`, method: "POST", body: {} },
  { path: `/api/rider/offers/${NO_SUCH_ORDER}/reject`, method: "POST", body: { reason: "too_far" } },
];

async function contract(): Promise<void> {
  try {
    await call("/api/rider/board");
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }

  for (const r of ROUTES) {
    const res = await call(r.path, { method: r.method, body: r.body });
    check(`no cookie -> 401  ${r.method} ${r.path}`, res.status === 401, res);
  }

  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    for (const r of ROUTES) {
      const res = await call(r.path, { method: r.method, body: r.body, cookie });
      check(
        `customer -> 403 not_rider  ${r.method} ${r.path}`,
        res.status === 403 && res.json?.error === "not_rider",
        res
      );
    }
  } else {
    skip("customer 403 checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }

  if (!RIDER_EMAIL || !RIDER_PASSWORD) {
    skip("rider checks (400 invalid_reason / invalid_order, board shape, 503 migration_pending): QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const reject = (orderId: string, body: unknown) =>
    call(`/api/rider/offers/${orderId}/reject`, { method: "POST", cookie, body });

  // Validation runs before any table is touched, so it holds with or without 0081/0082.
  const noReason = await reject(NO_SUCH_ORDER, {});
  check("reject {} -> 400 invalid_reason", noReason.status === 400 && noReason.json?.error === "invalid_reason", noReason);
  const badReason = await reject(NO_SUCH_ORDER, { reason: "because" });
  check("reject {reason:\"because\"} -> 400 invalid_reason", badReason.status === 400 && badReason.json?.error === "invalid_reason", badReason);
  const badOrder = await reject("not-a-uuid", { reason: "too_far" });
  check("reject on a non-uuid order -> 400 invalid_order", badOrder.status === 400 && badOrder.json?.error === "invalid_order", badOrder);
  const badAccept = await call("/api/rider/offers/not-a-uuid/accept", { method: "POST", cookie, body: {} });
  check("accept on a non-uuid order -> 400 invalid_order", badAccept.status === 400 && badAccept.json?.error === "invalid_order", badAccept);

  const board = await call("/api/rider/board", { cookie });
  const bj = board.json ?? {};
  // Reads degrade without the schema: the board is a 200 with no offers.
  check("rider: board -> 200", board.status === 200, board);
  check(
    "board: shape",
    Array.isArray(bj.offers) &&
      Array.isArray(bj.upcoming) &&
      (bj.active === null || typeof bj.active === "object") &&
      typeof bj.offerWindowSeconds === "number",
    bj
  );

  const me = (await call("/api/rider/me", { cookie })).json ?? {};
  const schemaPresent = me.riderCode !== null && me.riderCode !== undefined;
  const gone = await call(`/api/rider/offers/${NO_SUCH_ORDER}/accept`, { method: "POST", cookie, body: {} });
  if (!schemaPresent) {
    // Writes fail closed: with no rider_status the server cannot tell the rider
    // is online, so accept refuses rather than guesses.
    check("no 0081: accept -> 503 migration_pending", gone.status === 503 && gone.json?.error === "migration_pending", gone);
    skip("accept/reject flow: /api/rider/me shows riderCode null - migration 0081/0082 is not applied here");
    return;
  }
  check(
    "accept on an order that does not exist -> 409 (never a 500)",
    gone.status === 409,
    gone
  );
  const notMine = await reject(NO_SUCH_ORDER, { reason: "too_far" });
  check("reject on an order not offered to this rider -> 409 not_offered", notMine.status === 409 && notMine.json?.error === "not_offered", notMine);
}

contract()
  .catch((e) => {
    failed++;
    console.log(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    console.log(failed ? `FAILED ${failed} (passed ${passed})` : `PASS ${passed} checks`);
    process.exit(failed ? 1 : 0);
  });
