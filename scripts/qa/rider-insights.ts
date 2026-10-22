/**
 * QA — rider dashboard, history and performance (Phase 4 Task 2): the pure
 * counting rules, the data layer against a fake PostgREST, and the route
 * contract.
 *
 *   npm run test:rider-insights   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD          a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account
 *
 * Three tiers:
 *
 *   1. Pure (`lib/rider/figures.ts`): the counting and rate rules over plain
 *      rows — IST bucketing, the 23:58 -> 00:10 delivery, zero denominators,
 *      reassigned-away outcomes, staff corrections, month bucketing across a
 *      year boundary, targets, cursors. Always run.
 *   2. The data layer (`data-access/rider-insights.ts`) against an in-memory
 *      PostgREST: a brand-new rider with no history, the twelve dashboard
 *      figures, keyset paging with a delivery landing mid-scroll, another
 *      rider's rows never shown, earnings hidden when the switch is off, and a
 *      database without 0081 (-> RiderSchemaPendingError -> 503
 *      migration_pending). Always run.
 *   3. Route contract against the dev server: no cookie is 401 on all five
 *      routes; a customer is 403; a rider's malformed query is 400. The
 *      session-dependent checks SKIP without QA accounts, and everything SKIPs
 *      when the server is not running (ruling R2: no database has 0081+).
 *
 * Never sends push/SMS/OTP and never writes live data: every ONESIGNAL variable
 * is removed before any module loads, the fake is the only thing read, and the
 * five routes are GET-only.
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

const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const order = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
const delivery = (n: number) => `de${String(n).padStart(6, "0")}-0000-4000-8000-000000000000`;
/** An IST wall-clock instant as ISO (UTC). */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

let eventSeq = 0;
/** One event fact (pure tier) for a delivery numbered `n`. */
function ev(n: number, kind: string, at: string, over: Partial<{ method: string | null; reason: string | null; id: number }> = {}) {
  return { id: over.id ?? ++eventSeq, deliveryId: delivery(n), orderId: order(n), kind, at, method: over.method ?? null, reason: over.reason ?? null };
}

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const f = await import("../../src/lib/rider/figures");

  await group("a brand-new rider: every figure is 0 or null, nothing is NaN (Review Focus 1)", () => {
    const now = new Date(ist("2026-03-10", "12:00"));
    assert.deepEqual(f.todayFigures([], "2026-03-10"), { deliveries: 0, completed: 0, cancelled: 0, failed: 0 });
    assert.equal(f.deliveredBetween([], "2026-03-09", "2026-03-10"), 0);
    const p = f.performanceFigures([], [], [], now);
    assert.deepEqual(p, { avgAcceptToDeliverMin: null, avgPickupToDeliverMin: null, acceptanceRate: null, failedRate: null, onlineHoursThisWeek: 0 });
    const months = f.monthlyReport([], [], [], now, null);
    assert.equal(months.length, 12);
    assert.ok(months.every((m) => m.delivered === 0 && m.failed === 0 && m.cancelled === 0 && m.acceptanceRate === null && m.avgDeliverMin === null && m.earnings === null && m.onlineHours === 0));
    assert.ok(!/NaN|Infinity/.test(JSON.stringify([p, months])));
    assert.equal(f.nearestTarget([]), null);
    assert.deepEqual(f.chooseTargets({ daily: 0, weekly: 0 }, []), { daily: 0, weekly: 0 });
  });

  await group("a delivery accepted at 23:58 IST and delivered at 00:10 is yesterday's delivery and today's completion (Review Focus 2)", () => {
    const stints = f.buildStints([
      ev(1, "accepted", ist("2026-03-09", "23:58")),
      ev(1, "picked_up", ist("2026-03-10", "00:03"), { method: "code" }),
      ev(1, "delivered", ist("2026-03-10", "00:10"), { method: "code" }),
    ]);
    assert.equal(stints.length, 1);
    assert.equal(stints[0].outcome, "delivered");
    assert.deepEqual(f.todayFigures(stints, "2026-03-09"), { deliveries: 1, completed: 0, cancelled: 0, failed: 0 }, "yesterday: accepted, not completed");
    assert.deepEqual(f.todayFigures(stints, "2026-03-10"), { deliveries: 0, completed: 1, cancelled: 0, failed: 0 }, "today: completed, not accepted");
    // 23:58 IST is 18:28 UTC - the same instant a UTC calendar would call the same day as 00:10 IST's 18:40.
    assert.equal(f.deliveredBetween(stints, "2026-03-10", "2026-03-10"), 1);
    assert.equal(f.deliveredBetween(stints, "2026-03-09", "2026-03-09"), 0);
  });

  await group("cancelled counts today's accepted stints that ended cancelled, failed or reassigned away; failed is shown apart", () => {
    const stints = f.buildStints([
      ev(1, "accepted", ist("2026-03-10", "09:00")), ev(1, "picked_up", ist("2026-03-10", "09:10")), ev(1, "delivered", ist("2026-03-10", "09:30")),
      ev(2, "accepted", ist("2026-03-10", "10:00")), ev(2, "picked_up", ist("2026-03-10", "10:10")), ev(2, "failed", ist("2026-03-10", "10:40"), { reason: "customer_unreachable" }),
      ev(3, "accepted", ist("2026-03-10", "11:00")), ev(3, "cancelled", ist("2026-03-10", "11:05")),
      ev(4, "accepted", ist("2026-03-10", "12:00")), ev(4, "reassigned", ist("2026-03-10", "12:20")),
      ev(5, "accepted", ist("2026-03-10", "13:00")), ev(5, "released", ist("2026-03-10", "13:02"), { reason: "released:go_offline:abc" }),
      ev(6, "accepted", ist("2026-03-10", "14:00")), // still in the rider's hands
    ]);
    assert.deepEqual(f.todayFigures(stints, "2026-03-10"), { deliveries: 6, completed: 1, cancelled: 4, failed: 1 });
    const by = new Map(stints.map((s) => [s.orderId, s]));
    assert.equal(by.get(order(4))!.outcome, "reassigned");
    assert.equal(by.get(order(5))!.outcome, "reassigned", "a release is handed back: reassigned away");
    assert.equal(by.get(order(6))!.outcome, null, "no terminal event: in flight");
    assert.equal(by.get(order(2))!.reason, "customer_unreachable");
  });

  await group("reassigned-away outcome: the rider who LOST the job, not the one who took it", () => {
    // Events are the losing rider's own: accepted, then reassigned (driver_id = that rider).
    const mine = f.buildStints([ev(7, "accepted", ist("2026-03-10", "09:00")), ev(7, "picked_up", ist("2026-03-10", "09:05")), ev(7, "reassigned", ist("2026-03-10", "09:20"))]);
    assert.equal(mine[0].outcome, "reassigned");
    assert.equal(mine[0].pickedUpAt, ist("2026-03-10", "09:05"));
    assert.equal(f.todayFigures(mine, "2026-03-10").cancelled, 1);
  });

  await group("a staff correction replaces the outcome instead of adding a second one", () => {
    const cancel = ev(8, "cancelled", ist("2026-03-10", "15:00"));
    const stints = f.buildStints([
      ev(8, "accepted", ist("2026-03-10", "09:00")), ev(8, "picked_up", ist("2026-03-10", "09:05")),
      ev(8, "delivered", ist("2026-03-10", "09:30")), cancel,
    ]);
    assert.equal(stints.length, 1);
    assert.equal(stints[0].outcome, "cancelled");
    assert.deepEqual(f.todayFigures(stints, "2026-03-10"), { deliveries: 1, completed: 0, cancelled: 1, failed: 0 });
    assert.equal(stints[0].endEventId, cancel.id, "the later event is the stint's end");
  });

  await group("released then accepted again is two stints; a stint begun before the window still counts when it ends", () => {
    const two = f.buildStints([
      ev(9, "accepted", ist("2026-03-10", "09:00")), ev(9, "released", ist("2026-03-10", "09:10")),
      ev(9, "accepted", ist("2026-03-10", "10:00")), ev(9, "picked_up", ist("2026-03-10", "10:05")), ev(9, "delivered", ist("2026-03-10", "10:30")),
    ]);
    assert.deepEqual(two.map((s) => s.outcome), ["reassigned", "delivered"]);
    assert.equal(f.todayFigures(two, "2026-03-10").completed, 1);
    const late = f.buildStints([ev(10, "picked_up", ist("2026-03-10", "00:05")), ev(10, "delivered", ist("2026-03-10", "00:30"))]);
    assert.equal(late.length, 1);
    assert.equal(late[0].acceptedAt, null);
    assert.equal(late[0].outcome, "delivered");
    assert.deepEqual(f.todayFigures(late, "2026-03-10"), { deliveries: 0, completed: 1, cancelled: 0, failed: 0 }, "accepted before the window: not today's, but completed today");
    const orphan = f.buildStints([ev(11, "cancelled", ist("2026-03-10", "08:00"))]);
    assert.equal(orphan[0].outcome, "cancelled");
  });

  await group("rates: zero denominators are null, never 0 % or 100 %", () => {
    assert.equal(f.percent(0, 0), null);
    assert.equal(f.percent(5, 0), null);
    assert.equal(f.percent(0, 4), 0);
    assert.equal(f.percent(1, 3), 33.3);
    assert.equal(f.percent(4, 4), 100);
    const offers = [
      ...Array.from({ length: 3 }, (_, i) => ({ kind: "accepted" as const, at: ist("2026-03-10", `1${i}:00`) })),
      { kind: "rejected" as const, at: ist("2026-03-10", "13:00") },
      { kind: "lapsed" as const, at: ist("2026-03-10", "14:00") },
    ];
    const now = new Date(ist("2026-03-10", "18:00"));
    assert.equal(f.performanceFigures([], offers, [], now).acceptanceRate, 60, "3 / (3 + 1 + 1)");
    assert.equal(f.performanceFigures([], [{ kind: "rejected", at: ist("2026-03-10", "13:00") }], [], now).acceptanceRate, 0, "offers made, none accepted: a real 0 %");
    const delivered = (n: number, h: string) => [ev(n, "accepted", ist("2026-03-10", `${h}:00`)), ev(n, "picked_up", ist("2026-03-10", `${h}:10`)), ev(n, "delivered", ist("2026-03-10", `${h}:40`))];
    const stints = f.buildStints([...delivered(21, "09"), ...delivered(22, "10"), ...delivered(23, "11"), ev(24, "accepted", ist("2026-03-10", "12:00")), ev(24, "picked_up", ist("2026-03-10", "12:10")), ev(24, "failed", ist("2026-03-10", "12:50"), { reason: "x" })]);
    assert.equal(f.performanceFigures(stints, [], [], now).failedRate, 25, "1 / (3 + 1)");
    const onlyFailed = f.buildStints([ev(25, "accepted", ist("2026-03-10", "12:00")), ev(25, "failed", ist("2026-03-10", "12:50"), { reason: "x" })]);
    assert.equal(f.performanceFigures(onlyFailed, [], [], now).failedRate, 100, "every attempt failed: 100 %");
    const onlyCancelled = f.buildStints([ev(26, "accepted", ist("2026-03-10", "12:00")), ev(26, "cancelled", ist("2026-03-10", "12:50"))]);
    assert.equal(f.performanceFigures(onlyCancelled, [], [], now).failedRate, null, "a cancellation is neither delivered nor failed: no denominator");
  });

  await group("average times: delivered only, accepted -> delivered and picked up -> delivered", () => {
    const stints = f.buildStints([
      ev(31, "accepted", ist("2026-03-10", "09:00")), ev(31, "picked_up", ist("2026-03-10", "09:10")), ev(31, "delivered", ist("2026-03-10", "09:40")),
      ev(32, "accepted", ist("2026-03-10", "10:00")), ev(32, "picked_up", ist("2026-03-10", "10:20")), ev(32, "delivered", ist("2026-03-10", "10:30")),
      // A failed delivery and a cancelled one are not "delivery time".
      ev(33, "accepted", ist("2026-03-10", "11:00")), ev(33, "picked_up", ist("2026-03-10", "11:05")), ev(33, "failed", ist("2026-03-10", "12:59"), { reason: "x" }),
      ev(34, "accepted", ist("2026-03-10", "13:00")), ev(34, "cancelled", ist("2026-03-10", "13:50")),
    ]);
    const p = f.performanceFigures(stints, [], [], new Date(ist("2026-03-10", "18:00")));
    assert.equal(p.avgAcceptToDeliverMin, 35, "(40 + 30) / 2");
    assert.equal(p.avgPickupToDeliverMin, 20, "(30 + 10) / 2");
    assert.equal(f.averageMinutes([["2026-03-10T10:00:00Z", "2026-03-10T09:00:00Z"]]), null, "a negative span is ignored");
    assert.equal(f.averageMinutes([[null, "2026-03-10T09:00:00Z"]]), null);
  });

  await group("the headline looks back 30 IST days; older deliveries only reach the monthly report", () => {
    const now = new Date(ist("2026-03-10", "12:00"));
    const old = f.buildStints([ev(41, "accepted", ist("2026-02-01", "09:00")), ev(41, "picked_up", ist("2026-02-01", "09:05")), ev(41, "delivered", ist("2026-02-01", "09:50"))]);
    assert.equal(f.performanceFigures(old, [], [], now).avgAcceptToDeliverMin, null, "40 days ago is outside the 30-day window");
    const edge = f.buildStints([ev(42, "accepted", ist("2026-02-09", "09:00")), ev(42, "picked_up", ist("2026-02-09", "09:05")), ev(42, "delivered", ist("2026-02-09", "09:50"))]);
    assert.equal(f.performanceFigures(edge, [], [], now).avgAcceptToDeliverMin, 50, "9 Feb is day 30 counting 10 Mar as day 1");
    const gone = f.buildStints([ev(43, "accepted", ist("2026-02-08", "09:00")), ev(43, "picked_up", ist("2026-02-08", "09:05")), ev(43, "delivered", ist("2026-02-08", "09:50"))]);
    assert.equal(f.performanceFigures(gone, [], [], now).avgAcceptToDeliverMin, null);
  });

  await group("months: the last twelve, newest first, across a year boundary", () => {
    assert.deepEqual(f.lastMonths("2026-01-15"), ["2026-01", "2025-12", "2025-11", "2025-10", "2025-09", "2025-08", "2025-07", "2025-06", "2025-05", "2025-04", "2025-03", "2025-02"]);
    assert.equal(f.lastMonths("2026-12-31")[11], "2026-01");
    assert.equal(f.lastMonths("2026-01-01", 1)[0], "2026-01");
    const now = new Date(ist("2026-01-15", "12:00"));
    const stints = f.buildStints([
      // 31 Dec 23:30 IST is 18:00 UTC on 31 Dec; 1 Jan 00:10 IST is 18:40 UTC on 31 Dec - still December in UTC.
      ev(51, "accepted", ist("2025-12-31", "23:00")), ev(51, "picked_up", ist("2025-12-31", "23:10")), ev(51, "delivered", ist("2025-12-31", "23:30")),
      ev(52, "accepted", ist("2025-12-31", "23:50")), ev(52, "picked_up", ist("2025-12-31", "23:55")), ev(52, "delivered", ist("2026-01-01", "00:10")),
      ev(53, "accepted", ist("2026-01-02", "10:00")), ev(53, "failed", ist("2026-01-02", "10:30"), { reason: "x" }),
      ev(54, "accepted", ist("2026-01-03", "10:00")), ev(54, "cancelled", ist("2026-01-03", "10:10")),
      ev(55, "accepted", ist("2026-01-04", "10:00")), ev(55, "reassigned", ist("2026-01-04", "10:10")),
    ]);
    const offers = [
      { kind: "accepted" as const, at: ist("2025-12-31", "23:00") }, { kind: "rejected" as const, at: ist("2025-12-31", "22:00") },
      { kind: "accepted" as const, at: ist("2026-01-02", "10:00") },
    ];
    const report = f.monthlyReport(stints, offers, [], now, null);
    const jan = report.find((m) => m.month === "2026-01")!;
    const dec = report.find((m) => m.month === "2025-12")!;
    assert.equal(report[0].month, "2026-01");
    assert.equal(jan.delivered, 1, "the 00:10 delivery is January");
    assert.equal(dec.delivered, 1, "the 23:30 delivery is December");
    assert.equal(jan.failed, 1);
    assert.equal(jan.cancelled, 2, "cancelled plus reassigned away");
    assert.equal(dec.acceptanceRate, 50, "1 accepted of 2 offers");
    assert.equal(jan.acceptanceRate, 100);
    assert.equal(dec.avgDeliverMin, 30, "23:00 -> 23:30 only (the other ended in January)");
    assert.equal(jan.avgDeliverMin, 20, "23:50 -> 00:10 ended in January");
  });

  await group("online hours: an open shift runs to now, clipped to the week and the month", () => {
    const now = new Date(ist("2026-03-12", "12:00")); // Thursday; the week began Monday 9 Mar
    const shifts = [
      { startedAt: ist("2026-03-08", "20:00"), endedAt: ist("2026-03-09", "02:00") }, // Sunday night into Monday: 2 h this week
      { startedAt: ist("2026-03-10", "09:00"), endedAt: ist("2026-03-10", "13:30") }, // 4.5 h
      { startedAt: ist("2026-03-12", "10:00"), endedAt: null }, // open: 2 h so far
    ];
    assert.equal(f.performanceFigures([], [], shifts, now).onlineHoursThisWeek, 8.5);
    const feb = [{ startedAt: ist("2026-02-28", "22:00"), endedAt: ist("2026-03-01", "02:00") }];
    const report = f.monthlyReport([], [], feb, now, null);
    assert.equal(report.find((m) => m.month === "2026-02")!.onlineHours, 2, "the part before midnight on the 1st");
    assert.equal(report.find((m) => m.month === "2026-03")!.onlineHours, 2, "the part after it");
    assert.equal(f.onlineHours([{ startedAt: ist("2026-03-12", "11:00"), endedAt: null }], 0, Date.parse(ist("2026-03-13", "00:00")), now.getTime()), 1, "never counted past now");
  });

  await group("targets: the admin's default, else the largest active rule, else none", () => {
    const rules = [
      { period: "daily" as const, target: 8 }, { period: "daily" as const, target: 12 }, { period: "weekly" as const, target: 60 },
    ];
    assert.deepEqual(f.chooseTargets({ daily: 10, weekly: 70 }, rules), { daily: 10, weekly: 70 });
    assert.deepEqual(f.chooseTargets({ daily: 0, weekly: 0 }, rules), { daily: 12, weekly: 60 });
    assert.deepEqual(f.chooseTargets({ daily: 0, weekly: 70 }, [{ period: "daily", target: 5 }]), { daily: 5, weekly: 70 });
    assert.deepEqual(f.chooseTargets({ daily: 0, weekly: 0 }, []), { daily: 0, weekly: 0 }, "hidden");
    assert.deepEqual(f.chooseTargets({ daily: Number.NaN, weekly: -3 }, []), { daily: 0, weekly: 0 });
  });

  await group("nearest target: fewest deliveries to go among rules not yet earned", () => {
    const p = (name: string, done: number, target: number, bonus: number, earned = false) => ({ name, done, target, bonus, earned });
    assert.deepEqual(f.nearestTarget([p("Daily 10", 4, 10, 100), p("Weekly 40", 36, 40, 300), p("Done", 10, 10, 50, true)]), { name: "Weekly 40", done: 36, target: 40, bonus: 300 });
    assert.equal(f.nearestTarget([p("Done", 10, 10, 50, true)]), null, "everything earned: nothing left to chase");
    assert.equal(f.nearestTarget([p("Tie small", 8, 10, 50), p("Tie big", 18, 20, 80)])!.name, "Tie big", "equal distance: the bigger bonus");
  });

  await group("monthly money keeps the ledger's months and leaves ₹0 months out", () => {
    const m = f.monthlyMoney([
      { date: "2026-01-05", amount: 0 }, { date: "2026-01-06", amount: 0 },
      { date: "2025-12-31", amount: 5000 }, { date: "2025-12-20", amount: -250.5 },
      { date: "2025-11-02", amount: 10 }, { date: "2025-11-03", amount: -10 },
    ]);
    assert.deepEqual([...m], [["2025-12", 4749.5]]);
    const now = new Date(ist("2026-01-15", "12:00"));
    const rows = f.monthlyReport([], [], [], now, m);
    assert.equal(rows.find((r) => r.month === "2025-12")!.earnings, 4749.5);
    assert.equal(rows.find((r) => r.month === "2026-01")!.earnings, null);
  });

  await group("the delivery status and the next step", () => {
    assert.equal(f.riderDeliveryStatus({ status: "assigned" }), "accepted");
    assert.equal(f.riderDeliveryStatus({ status: "assigned", arrived_pickup_at: "x" }), "arrived_pickup");
    assert.equal(f.riderDeliveryStatus({ status: "picked_up" }), "picked_up");
    assert.equal(f.riderDeliveryStatus({ status: "picked_up", departed_pickup_at: "x" }), "on_the_way");
    assert.equal(f.riderDeliveryStatus({ status: "picked_up", departed_pickup_at: "x", arrived_drop_at: "y" }), "arrived_drop");
    assert.equal(f.nextStepFor("accepted"), "Go to the shop");
    assert.equal(f.nextStepFor("arrived_drop"), "Hand over the order");
    for (const s of ["accepted", "arrived_pickup", "picked_up", "on_the_way", "arrived_drop"] as const) assert.match(f.nextStepFor(s), /^[A-Z][A-Za-z ]+$/, "plain English, no Devanagari");
  });

  await group("history helpers: kinds per filter, proof, reasons, cursors", () => {
    assert.deepEqual(f.historyKinds("reassigned"), ["reassigned", "released"]);
    assert.deepEqual(f.historyKinds("delivered"), ["delivered"]);
    assert.equal(f.historyKinds().length, 5);
    assert.equal(f.proofOf("code"), "code");
    assert.equal(f.proofOf("ops_approved"), "ops_approved");
    assert.equal(f.proofOf("staff"), "staff");
    assert.equal(f.proofOf("qr"), null);
    assert.equal(f.proofOf(null), null);
    assert.equal(f.historyReason("failed", "  customer not reachable "), "customer not reachable");
    assert.equal(f.historyReason("released", "released:go_offline:7b1"), "Handed back when going offline");
    assert.equal(f.historyReason("released", null), "Handed back to dispatch");
    assert.equal(f.historyReason("reassigned", "ops note"), null);
    const key = { at: "2026-03-10T10:00:00.123456+00:00", id: 42 };
    assert.deepEqual(f.decodeHistoryCursor(f.encodeHistoryCursor(key)), key);
    for (const at of ["2026-02-30T10:00:00Z", "2026-03-10T25:00:00Z", "2026-03-10T10:00:00Z junk", "2026-03-10T10:00:00.1234567Z", "2026-03-10 10:00:00Z"]) {
      assert.equal(f.decodeHistoryCursor(Buffer.from(`${at}|5`).toString("base64url")), null, `not a real instant: ${at}`);
    }
    assert.ok(f.decodeHistoryCursor(Buffer.from("2026-03-10T10:00:00.123456+00:00|5").toString("base64url")), "PostgREST\'s own format is accepted");
    assert.ok(f.decodeHistoryCursor(Buffer.from("2026-03-10T10:00:00Z|5").toString("base64url")));
    for (const bad of ["", "zzz", "not base64!", Buffer.from("nodelimiter").toString("base64url"), Buffer.from("garbage|1").toString("base64url"), Buffer.from("2026-03-10T10:00:00Z|x").toString("base64url"), "a".repeat(300)]) {
      assert.equal(f.decodeHistoryCursor(bad), null, `rejected: ${bad.slice(0, 20)}`);
    }
    assert.ok(f.micros("2026-03-10T10:00:00.123999+00:00") > f.micros("2026-03-10T10:00:00.123456+00:00"), "microseconds are kept");
    assert.ok(f.isAfterCursor({ at: "2026-03-10T09:00:00+00:00", id: 9 }, key), "older is after the cursor");
    assert.ok(!f.isAfterCursor({ at: "2026-03-10T10:00:00.123456+00:00", id: 42 }, key), "the cursor row itself is not");
    assert.ok(f.isAfterCursor({ at: "2026-03-10T10:00:00.123456+00:00", id: 41 }, key), "same instant, lower id");
    assert.ok(!f.isAfterCursor({ at: "2026-03-10T10:00:00.123999+00:00", id: 1 }, key), "newer is not");
  });
}


// ---------------------------------------------------------------------------
// 2. data layer against a fake PostgREST
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const mode = { missingTables: new Set<string>(), failReads: new Set<string>(), signedFor: [] as { path: string; expiresIn: number }[] };
const requests: { method: string; table: string; query: string }[] = [];
const t = (name: string): Row[] => (db[name] ??= []);
let eventId = 0;
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingTables.clear();
  mode.failReads.clear();
  mode.signedFor.length = 0;
  requests.length = 0;
  eventId = 0;
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function compare(a: unknown, b: string): number {
  const n = Number(b);
  if (typeof a === "number" && Number.isFinite(n)) return a - n;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    const value = row[key];
    const negate = raw.startsWith("not.");
    const body = negate ? raw.slice(4) : raw;
    const dot = body.indexOf(".");
    const op = body.slice(0, dot);
    const arg = body.slice(dot + 1);
    let hit: boolean;
    switch (op) {
      case "eq": hit = String(value) === arg; break;
      case "neq": hit = String(value) !== arg; break;
      case "in": hit = arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value)); break;
      case "is": hit = arg === "null" ? value === null || value === undefined : String(value) === arg; break;
      case "gt": hit = value != null && compare(value, arg) > 0; break;
      case "gte": hit = value != null && compare(value, arg) >= 0; break;
      case "lt": hit = value != null && compare(value, arg) < 0; break;
      case "lte": hit = value != null && compare(value, arg) <= 0; break;
      default: throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}

function ordered(rows: Row[], url: URL): Row[] {
  const spec = url.searchParams.get("order");
  if (!spec) return rows;
  const keys = spec.split(",").map((s) => {
    const [col, dir] = s.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { col, sign } of keys) {
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * sign;
    }
    return 0;
  });
}

/** PostgREST's default `max-rows` on Supabase. */
const MAX_ROWS = 1000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      const path = decodeURIComponent(url.pathname.replace("/storage/v1/object/sign/", ""));
      const body = raw ? (JSON.parse(raw) as Row) : {};
      mode.signedFor.push({ path, expiresIn: Number(body.expiresIn) });
      return send(200, { signedURL: `/object/sign/${path}?token=T` });
    }
    const table = url.pathname.replace("/rest/v1/", "");
    requests.push({ method: req.method ?? "", table, query: url.search });
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length === 0) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };
    if (table.startsWith("rpc/")) return send(200, null);
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (mode.failReads.has(table)) return send(500, { code: "XX000", message: "boom" });
      let rows = ordered(t(table).filter((r) => matches(r, url)), url);
      const offset = Number(url.searchParams.get("offset")) || 0;
      if (offset > 0) rows = rows.slice(offset);
      const limit = Number(url.searchParams.get("limit"));
      rows = rows.slice(0, limit > 0 ? Math.min(limit, MAX_ROWS) : MAX_ROWS);
      return respond(rows);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

const PAST = "2026-03-10"; // "today" for the dashboard fixtures (a Tuesday); the week began Monday 9 March
const NOW = new Date(ist(PAST, "15:00"));

/** A delivery_events row naming `driver`. */
function seedEvent(driver: string, n: number, kind: string, at: string, over: Row = {}): Row {
  const row = { id: ++eventId, delivery_id: delivery(n), order_id: order(n), driver_id: driver, kind, method: null, reason: null, created_at: at, ...over };
  t("delivery_events").push(row);
  return row;
}
function seedDelivery(n: number, driver: string | null, status: string, over: Row = {}): Row {
  const row = {
    id: delivery(n), order_id: order(n), driver_id: driver, status, assigned_at: null, picked_up_at: null,
    arrived_pickup_at: null, departed_pickup_at: null, arrived_drop_at: null, distance_km: null, delivery_method: null,
    failure_reason: null, pod_photo_path: null, offered_driver_id: null, offered_at: null, ...over,
  };
  t("deliveries").push(row);
  return row;
}
function seedOrder(n: number, over: Row = {}): void {
  t("orders").push({
    id: order(n), status: "ready", total: 250 + n, restaurant_id: `r-${n % 3}`, address: { label: `Area ${n % 5}`, line: "House 12, Secret Street, Bemetara", lat: 21.7, lng: 81.5 },
    cancelled_by: null, cancellation_reason: null, ...over,
  });
  t("order_items").push({ id: `oi-${n}-a`, order_id: order(n), name: "Paneer roll", qty: 2 }, { id: `oi-${n}-b`, order_id: order(n), name: "Cola", qty: 1 });
}
function seedShops(): void {
  t("restaurants").push({ id: "r-0", name: "Shop Zero" }, { id: "r-1", name: "Shop One" }, { id: "r-2", name: "Shop Two" });
}
function seedEarning(id: string, n: number, driver: string, at: string, amount: number): void {
  t("rider_earnings").push({
    id, delivery_id: delivery(n), attempt: 1, order_id: order(n), driver_id: driver, earned_at: at, base_fee: amount, distance_km: 3,
    distance_source: "road", billable_km: 0, distance_fee: 0, min_topup: 0, tip_amount: 0, tip_in_cash: true, amount, payout_id: null, created_at: at,
  });
}
/** A whole accepted -> picked up -> delivered run (accepted at hh:00, picked up hh:10, delivered hh:40). */
function seedDelivered(n: number, day: string, hh: string, over: { driver?: string; method?: string; earning?: number } = {}): void {
  const driver = over.driver ?? D1;
  const a = ist(day, `${hh}:00`), p = ist(day, `${hh}:10`), d = ist(day, `${hh}:40`);
  seedOrder(n);
  seedDelivery(n, driver, "delivered", { assigned_at: a, picked_up_at: p, delivered_at: d, distance_km: 3.4, delivery_method: over.method ?? "code" });
  seedEvent(driver, n, "accepted", a);
  seedEvent(driver, n, "picked_up", p, { method: "code" });
  seedEvent(driver, n, "delivered", d, { method: over.method ?? "code" });
  if (over.earning !== undefined) seedEarning(`e-${n}`, n, driver, d, over.earning);
}

function seedBusyDay(): void {
  reset();
  seedShops();
  // o7: accepted yesterday 23:58, delivered today 00:10 - yesterday's delivery, today's completion.
  seedOrder(7);
  seedDelivery(7, D1, "delivered", { assigned_at: ist("2026-03-09", "23:58"), delivered_at: ist(PAST, "00:10"), delivery_method: "code" });
  seedEvent(D1, 7, "accepted", ist("2026-03-09", "23:58"));
  seedEvent(D1, 7, "picked_up", ist(PAST, "00:03"), { method: "code" });
  seedEvent(D1, 7, "delivered", ist(PAST, "00:10"), { method: "code" });
  seedDelivered(1, PAST, "09");
  // o2 failed, o3 cancelled by the customer, o4 reassigned away to the other rider
  seedOrder(2);
  seedDelivery(2, D1, "failed", { assigned_at: ist(PAST, "10:00"), failure_reason: "Customer not reachable" });
  seedEvent(D1, 2, "accepted", ist(PAST, "10:00"));
  seedEvent(D1, 2, "picked_up", ist(PAST, "10:10"));
  seedEvent(D1, 2, "failed", ist(PAST, "10:30"), { reason: "Customer not reachable" });
  seedOrder(3, { cancelled_by: "customer", cancellation_reason: "Changed my mind" });
  seedDelivery(3, D1, "cancelled", { assigned_at: ist(PAST, "11:00") });
  seedEvent(D1, 3, "accepted", ist(PAST, "11:00"));
  seedEvent(D1, 3, "cancelled", ist(PAST, "11:05"));
  seedOrder(4);
  seedDelivery(4, D2, "assigned", { assigned_at: ist(PAST, "12:25") });
  seedEvent(D1, 4, "accepted", ist(PAST, "12:00"));
  seedEvent(D1, 4, "reassigned", ist(PAST, "12:20"));
  seedEvent(D2, 4, "accepted", ist(PAST, "12:20"));
  // o5 accepted only; o6 picked up and on the way
  seedOrder(5);
  seedDelivery(5, D1, "assigned", { assigned_at: ist(PAST, "13:00") });
  seedEvent(D1, 5, "accepted", ist(PAST, "13:00"));
  seedOrder(6);
  seedDelivery(6, D1, "picked_up", { assigned_at: ist(PAST, "13:30"), picked_up_at: ist(PAST, "13:40"), departed_pickup_at: ist(PAST, "13:45") });
  seedEvent(D1, 6, "accepted", ist(PAST, "13:30"));
  seedEvent(D1, 6, "picked_up", ist(PAST, "13:40"));
  // offers: one held for D1 right now, one for D1 whose window has passed, one for D2
  seedOrder(8);
  seedDelivery(8, null, "unassigned", { offered_driver_id: D1, offered_at: ist(PAST, "14:59") });
  seedOrder(9);
  seedDelivery(9, null, "unassigned", { offered_driver_id: D1, offered_at: ist(PAST, "14:00") });
  seedOrder(10);
  seedDelivery(10, null, "unassigned", { offered_driver_id: D2, offered_at: ist(PAST, "14:59") });
  // an upcoming pickup (order still cooking) offered to D1 an hour ago: Jobs lists it under Upcoming
  // whatever the window, so Home counts it; one offered to D2 is theirs.
  seedOrder(12, { status: "kitchen" });
  seedDelivery(12, null, "unassigned", { offered_driver_id: D1, offered_at: ist(PAST, "14:00") });
  seedOrder(13, { status: "kitchen" });
  seedDelivery(13, null, "unassigned", { offered_driver_id: D2, offered_at: ist(PAST, "14:00") });
  // the other rider's own day, which must never leak in
  seedOrder(11);
  seedDelivery(11, D2, "delivered", { delivered_at: ist(PAST, "09:30") });
  seedEvent(D2, 11, "accepted", ist(PAST, "09:00"));
  seedEvent(D2, 11, "delivered", ist(PAST, "09:30"));
  // money: 38 today, 40 yesterday; awards 100 (this week) and 50 (last week); two active rules
  seedEarning("m1", 1, D1, ist(PAST, "09:40"), 38);
  seedEarning("m2", 70, D1, ist("2026-03-09", "12:00"), 40);
  seedEarning("mo", 71, D2, ist(PAST, "09:00"), 999);
  t("rider_incentive_rules").push(
    { id: "ru1", name: "Daily 5", period: "daily", target_deliveries: 5, bonus_amount: 100, window_start: null, window_end: null, starts_on: "2026-03-01", ends_on: null, active: true, created_at: "2026-03-01T00:00:00Z" },
    { id: "ru2", name: "Weekly 20", period: "weekly", target_deliveries: 20, bonus_amount: 400, window_start: null, window_end: null, starts_on: "2026-03-01", ends_on: null, active: true, created_at: "2026-03-01T00:00:01Z" }
  );
  t("rider_incentive_awards").push(
    { id: "aw1", rule_id: "ru1", driver_id: D1, period_start: "2026-03-09", deliveries_count: 5, amount: 100, trigger_earning_id: "m2", awarded_at: ist("2026-03-09", "15:00"), notified_at: null, payout_id: null },
    { id: "aw0", rule_id: "ru1", driver_id: D1, period_start: "2026-03-02", deliveries_count: 5, amount: 50, trigger_earning_id: null, awarded_at: ist("2026-03-02", "15:00"), notified_at: null, payout_id: null }
  );
  t("rider_status").push({ driver_id: D1, is_online: true, break_until: null, online_since: ist(PAST, "08:00"), last_fix_at: ist(PAST, "14:58"), updated_at: ist(PAST, "14:58") });
}

const LEDGER_TABLES = ["rider_earnings", "rider_incentive_awards", "rider_incentive_rules", "rider_adjustments", "rider_payouts"];

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const x = await import("../../src/lib/data-access/rider-insights");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");
  const settings = { riderOfferWindowSeconds: 180, riderDailyTarget: 0, riderWeeklyTarget: 0 };
  const reads = (table: string) => requests.filter((r) => r.table === table);
  const inputError = (code: string) => (e: unknown) => e instanceof x.InsightsInputError && e.code === code;
  const code = (n: number) => `#${order(n).slice(0, 8).toUpperCase()}`;

  await group("data: a brand-new rider - zeros and nulls, no errors (Review Focus 1)", async () => {
    reset();
    const board = await x.getRiderDashboard(D1, NOW, { settings, earnings: true });
    assert.deepEqual(board.today, { deliveries: 0, pending: 0, accepted: 0, pickedUp: 0, completed: 0, cancelled: 0, failed: 0 });
    assert.equal(board.current, null);
    assert.equal(board.availability.isOnline, false);
    assert.equal(board.phase, "offline");
    assert.equal(board.nearestTarget, null);
    assert.deepEqual(board.money, { today: 0, total: 0, pending: 0, incentivesThisWeek: 0 });
    assert.equal(board.updatedAt, NOW.toISOString());
    const hist = await x.getRiderHistory(D1, {}, { earnings: true });
    assert.deepEqual(hist, { items: [], nextCursor: null });
    const perf = await x.getRiderPerformance(D1, NOW, { settings, earnings: true });
    assert.deepEqual(perf.daily, { target: 0, done: 0 });
    assert.deepEqual(perf.weekly, { target: 0, done: 0 });
    assert.equal(perf.avgAcceptToDeliverMin, null);
    assert.equal(perf.avgPickupToDeliverMin, null);
    assert.equal(perf.acceptanceRate, null);
    assert.equal(perf.failedRate, null);
    assert.equal(perf.onlineHoursThisWeek, 0);
    assert.deepEqual(perf.rating, { average: null, count: 0, recent: [] });
    assert.equal(perf.months.length, 12);
    assert.ok(perf.months.every((m) => m.delivered === 0 && m.earnings === null && m.acceptanceRate === null));
    assert.ok(!/NaN|Infinity/.test(JSON.stringify([board, hist, perf])));
    assert.deepEqual(await x.getRiderRatings(D1, {}), { average: null, count: 0, items: [], nextCursor: null });
  });

  await group("data: the dashboard's twelve figures, from the same rules as History and Performance", async () => {
    seedBusyDay();
    const b = await x.getRiderDashboard(D1, NOW, { settings, earnings: true });
    // o1..o6 were accepted today; o7 was accepted yesterday
    assert.deepEqual(b.today, { deliveries: 6, pending: 2, accepted: 1, pickedUp: 1, completed: 2, cancelled: 3, failed: 1 });
    assert.equal(b.availability.isOnline, true);
    assert.equal(b.phase, "online");
    assert.deepEqual(b.current, { orderId: order(6), code: code(6), status: "on_the_way", next: "Reach the customer" });
    assert.deepEqual(b.money, { today: 38, total: 228, pending: 228, incentivesThisWeek: 100 });
    assert.deepEqual(b.nearestTarget, { name: "Daily 5", done: 1, target: 5, bonus: 100 });
    // the minute before midnight: o7 is already today's delivery, and not yet completed
    const yesterday = await x.getRiderDashboard(D1, new Date(ist("2026-03-09", "23:59")), { settings });
    assert.equal(yesterday.today.deliveries, 1);
    assert.equal(yesterday.today.completed, 0);
    // every read that names a rider names the session's
    for (const table of ["delivery_events", "deliveries", "rider_earnings", "rider_incentive_awards", "rider_status"]) {
      assert.ok(reads(table).every((r) => r.query.includes(`driver_id=eq.${D1}`)), `${table} reads are filtered to the rider`);
    }
  });

  await group("data: Pending is what Jobs lists - upcoming pickups with no window, ready offers inside it - and nothing while offline", async () => {
    seedBusyDay();
    // order 8 is ready and held inside the window; order 9 is ready with the window gone (open to all, not "held");
    // order 12 is a kitchen pickup offered an hour ago (Upcoming has no window).
    assert.equal((await x.getRiderDashboard(D1, NOW, { settings })).today.pending, 2);
    // ten minutes later the ready offer has lapsed; the upcoming pickup is still waiting
    assert.equal((await x.getRiderDashboard(D1, new Date(NOW.getTime() + 10 * 60_000), { settings })).today.pending, 1);
    // the order turns ready long after its offer: now it is a lapsed ready offer, not upcoming
    t("orders").find((o) => o.id === order(12))!.status = "ready";
    assert.equal((await x.getRiderDashboard(D1, NOW, { settings })).today.pending, 1);
    t("orders").find((o) => o.id === order(12))!.status = "kitchen";
    // offline: the Jobs board shows nothing, so Pending is 0
    t("rider_status")[0].is_online = false;
    assert.equal((await x.getRiderDashboard(D1, NOW, { settings })).today.pending, 0);
  });

  await group("data: earnings switched off - no money block, no incentive bonus either (Review Focus 5)", async () => {
    seedBusyDay();
    const b = await x.getRiderDashboard(D1, NOW, { settings });
    assert.equal(b.money, null);
    assert.equal(b.nearestTarget, null);
    assert.equal(reads("rider_earnings").length + reads("rider_incentive_awards").length + reads("rider_incentive_rules").length, 0, "the ledger is not even read");
    assert.equal(b.today.completed, 2, "the delivery counts are still there");
    const h = await x.getRiderHistory(D1, {});
    assert.ok(h.items.length > 0 && h.items.every((i) => i.earning === null), "no earnings on History rows");
    const p = await x.getRiderPerformance(D1, NOW, { settings });
    assert.ok(p.months.every((m) => m.earnings === null));
  });

  await group("data: money before 0083 is hidden, the other figures stay", async () => {
    seedBusyDay();
    for (const tbl of LEDGER_TABLES) mode.missingTables.add(tbl);
    const b = await x.getRiderDashboard(D1, NOW, { settings, earnings: true });
    assert.equal(b.money, null);
    assert.equal(b.nearestTarget, null);
    assert.equal(b.today.deliveries, 6);
    const h = await x.getRiderHistory(D1, {}, { earnings: true });
    assert.ok(h.items.length > 0 && h.items.every((i) => i.earning === null));
  });

  await group("data: History lists every outcome, newest first, with the fields the app shows", async () => {
    seedBusyDay();
    const h = await x.getRiderHistory(D1, {}, { earnings: true });
    assert.deepEqual(h.items.map((i) => [i.orderId, i.outcome]), [
      [order(4), "reassigned"], [order(3), "cancelled"], [order(2), "failed"], [order(1), "delivered"], [order(7), "delivered"],
    ]);
    assert.equal(h.nextCursor, null);
    const by = new Map(h.items.map((i) => [i.orderId, i]));
    assert.deepEqual({ ...by.get(order(1))! }, {
      orderId: order(1), code: code(1), shop: "Shop One", dropArea: "Area 1", outcome: "delivered",
      acceptedAt: ist(PAST, "09:00"), pickedUpAt: ist(PAST, "09:10"), deliveredAt: ist(PAST, "09:40"), endedAt: ist(PAST, "09:40"),
      distanceKm: 3.4, earning: 38, reason: null, cancelledBy: null, proof: "code", itemCount: 3, orderValue: 251,
    });
    assert.ok(!JSON.stringify(h).includes("Secret Street"), "the customer's address line never reaches History");
    const o2 = by.get(order(2))!;
    assert.equal(o2.reason, "Customer not reachable");
    assert.equal(o2.deliveredAt, null);
    assert.equal(o2.proof, null);
    const o3 = by.get(order(3))!;
    assert.equal(o3.reason, "Changed my mind");
    assert.equal(o3.cancelledBy, "customer");
    const o4 = by.get(order(4))!;
    assert.equal(o4.reason, null);
    assert.equal(o4.cancelledBy, null);
    assert.equal(o4.endedAt, ist(PAST, "12:20"));
    assert.equal(o4.acceptedAt, ist(PAST, "12:00"));
    const o7 = by.get(order(7))!;
    assert.equal(o7.acceptedAt, ist("2026-03-09", "23:58"), "accepted yesterday, delivered today: one row, ended today");
    assert.equal(o7.endedAt, ist(PAST, "00:10"));
    assert.ok(!h.items.some((i) => [order(5), order(6)].includes(i.orderId)), "in-flight deliveries are on Jobs, not in History");
    assert.ok(!h.items.some((i) => i.orderId === order(11)), "another rider's delivery is never listed");
    for (const r of reads("delivery_events")) assert.ok(r.query.includes(`driver_id=eq.${D1}`), "events filtered to the rider");
  });

  await group("data: a release is 'reassigned' with a sentence, not the machine string; a correction leaves one row", async () => {
    reset();
    seedShops();
    seedOrder(1);
    seedDelivery(1, null, "unassigned");
    seedEvent(D1, 1, "accepted", ist(PAST, "09:00"));
    seedEvent(D1, 1, "released", ist(PAST, "09:05"), { reason: "released:go_offline:7b1c" });
    seedOrder(2);
    seedDelivery(2, D1, "cancelled", { assigned_at: ist(PAST, "10:00") });
    seedEvent(D1, 2, "accepted", ist(PAST, "10:00"));
    seedEvent(D1, 2, "picked_up", ist(PAST, "10:05"));
    seedEvent(D1, 2, "delivered", ist(PAST, "10:30"), { method: "code" });
    seedEvent(D1, 2, "cancelled", ist(PAST, "12:00"));
    seedEvent(D1, 2, "corrected", ist(PAST, "12:00"), { reason: "Duplicate order" });
    const h = await x.getRiderHistory(D1, {});
    assert.deepEqual(h.items.map((i) => [i.orderId, i.outcome]), [[order(2), "cancelled"], [order(1), "reassigned"]], "the delivered row was superseded by the correction");
    assert.equal(h.items[1].reason, "Handed back when going offline");
    assert.ok(!JSON.stringify(h).includes("released:"));
    assert.deepEqual((await x.getRiderHistory(D1, { outcome: "delivered" })).items, [], "filtering to delivered does not resurrect the corrected delivery");
    assert.deepEqual((await x.getRiderHistory(D1, { outcome: "reassigned" })).items.map((i) => i.orderId), [order(1)]);
  });

  await group("data: keyset paging, 20 a page, no repeats when a delivery lands at the top (Review Focus 4)", async () => {
    reset();
    seedShops();
    const base = Date.parse(ist("2026-03-01", "08:00"));
    for (let i = 1; i <= 45; i++) {
      const a = new Date(base + i * 20 * 60_000);
      seedOrder(i);
      seedDelivery(i, D1, "delivered", { assigned_at: a.toISOString(), delivery_method: "code" });
      seedEvent(D1, i, "accepted", a.toISOString());
      seedEvent(D1, i, "picked_up", new Date(a.getTime() + 5 * 60_000).toISOString());
      seedEvent(D1, i, "delivered", new Date(a.getTime() + 15 * 60_000).toISOString(), { method: "code" });
    }
    const first = await x.getRiderHistory(D1, {});
    assert.equal(first.items.length, 20);
    assert.ok(first.nextCursor);
    // a delivery lands at the top while the rider scrolls
    seedOrder(99);
    seedDelivery(99, D1, "delivered", { delivery_method: "code" });
    seedEvent(D1, 99, "accepted", ist("2026-03-09", "10:00"));
    seedEvent(D1, 99, "picked_up", ist("2026-03-09", "10:05"));
    seedEvent(D1, 99, "delivered", ist("2026-03-09", "10:20"), { method: "code" });
    const second = await x.getRiderHistory(D1, { cursor: first.nextCursor });
    assert.equal(second.items.length, 20);
    const third = await x.getRiderHistory(D1, { cursor: second.nextCursor });
    assert.equal(third.items.length, 5);
    assert.equal(third.nextCursor, null);
    const all = [...first.items, ...second.items, ...third.items];
    assert.equal(new Set(all.map((i) => i.orderId)).size, 45, "45 distinct deliveries across the three pages");
    assert.ok(!all.some((i) => i.orderId === order(99)), "the newcomer is at the top of the next refresh, not injected into an old scroll");
    assert.equal((await x.getRiderHistory(D1, {})).items[0].orderId, order(99), "a refresh shows it first");
    const times = all.map((i) => i.endedAt);
    assert.deepEqual(times, [...times].sort().reverse(), "newest first across pages");
  });

  await group("data: thousands of rows in one status - pages stay 20 and the cursor does the work (Review Focus 4)", async () => {
    reset();
    seedShops();
    const base = Date.parse(ist("2025-06-01", "08:00"));
    for (let i = 1; i <= 2500; i++) {
      t("delivery_events").push({ id: ++eventId, delivery_id: delivery(i), order_id: order(i), driver_id: D1, kind: "delivered", method: "code", reason: null, created_at: new Date(base + i * 60_000).toISOString() });
    }
    // only the 60 newest have a delivery and order behind them in the fake: the rest must not be loaded
    for (let i = 2441; i <= 2500; i++) {
      seedOrder(i);
      seedDelivery(i, D1, "delivered", { delivery_method: "code" });
      t("delivery_events").push({ id: ++eventId, delivery_id: delivery(i), order_id: order(i), driver_id: D1, kind: "accepted", method: null, reason: null, created_at: new Date(base + i * 60_000 - 600_000).toISOString() });
    }
    requests.length = 0;
    const p1 = await x.getRiderHistory(D1, { outcome: "delivered" });
    assert.equal(p1.items.length, 20);
    const p2 = await x.getRiderHistory(D1, { outcome: "delivered", cursor: p1.nextCursor });
    assert.equal(p2.items.length, 20);
    assert.ok(p2.items[0].endedAt < p1.items[19].endedAt, "page 2 starts after page 1 ends");
    const limits = reads("delivery_events").map((r) => Number(/limit=(\d+)/.exec(r.query)?.[1] ?? 0)).filter(Boolean);
    assert.ok(limits.length >= 2 && limits.every((n) => n <= 100), `each page asks for a bounded number of rows (${limits.join(",")})`);
    assert.ok(requests.length < 40, `two pages are a handful of requests (${requests.length})`);
  });

  await group("data: History filters - outcome and IST date range", async () => {
    seedBusyDay();
    assert.deepEqual((await x.getRiderHistory(D1, { outcome: "failed" })).items.map((i) => i.orderId), [order(2)]);
    assert.deepEqual((await x.getRiderHistory(D1, { outcome: "cancelled", from: "2026-03-11", to: "2026-03-11" })).items, []);
    assert.deepEqual(
      (await x.getRiderHistory(D1, { from: "2026-03-10", to: "2026-03-10", outcome: "delivered" })).items.map((i) => i.orderId),
      [order(1), order(7)],
      "00:10 IST is 10 March in IST and 9 March in UTC"
    );
    assert.equal((await x.getRiderHistory(D1, { from: "2026-03-10" })).items.length, 5);
    assert.deepEqual((await x.getRiderHistory(D1, { to: "2026-03-09" })).items, []);
    await assert.rejects(x.getRiderHistory(D1, { from: "2026-3-1" }), inputError("invalid_date"));
    await assert.rejects(x.getRiderHistory(D1, { from: "2026-03-05", to: "2026-03-01" }), inputError("invalid_range"));
    await assert.rejects(x.getRiderHistory(D1, { from: "2025-01-01", to: "2026-03-01" }), inputError("invalid_range"));
    await assert.rejects(x.getRiderHistory(D1, { cursor: "zzz" }), inputError("invalid_cursor"));
    // well-formed base64, but the time is not a real instant: 400, never a 500 from the database
    requests.length = 0;
    for (const at of ["2026-02-30T10:00:00Z", "2026-03-10T25:00:00Z", "2026-03-10T10:00:00Z junk", "2026-13-10T10:00:00Z", "2026-03-10 10:00:00Z"]) {
      const cursor = Buffer.from(`${at}|5`).toString("base64url");
      await assert.rejects(x.getRiderHistory(D1, { cursor }), inputError("invalid_cursor"), at);
      await assert.rejects(x.getRiderRatings(D1, { cursor }), inputError("invalid_cursor"), at);
    }
    assert.equal(requests.filter((r) => r.table === "delivery_events").length, 0, "no bad cursor reached the database");
    await assert.rejects(x.getRiderHistory(D1, { outcome: "nope" as never }), inputError("invalid_outcome"));
  });

  await group("data: earning appears only when it is real money - never a ₹0 per-delivery row", async () => {
    reset();
    seedShops();
    seedDelivered(1, PAST, "09", { earning: 38 });
    seedDelivered(2, PAST, "10", { earning: 0 });
    seedDelivered(3, PAST, "11");
    const on = await x.getRiderHistory(D1, {}, { earnings: true });
    const e = new Map(on.items.map((i) => [i.orderId, i.earning]));
    assert.equal(e.get(order(1)), 38);
    assert.equal(e.get(order(2)), null, "₹0 is not shown as money");
    assert.equal(e.get(order(3)), null, "no ledger row: nothing to show");
    assert.ok((await x.getRiderHistory(D1, {})).items.every((i) => i.earning === null));
  });

  await group("data: History detail - timeline, items, signed proof photo (10 minutes), and only for the rider's own order", async () => {
    seedBusyDay();
    t("deliveries").find((d) => d.id === delivery(1))!.pod_photo_path = `${delivery(1)}/proof.jpg`;
    t("delivery_events").push({ id: ++eventId, delivery_id: delivery(1), order_id: order(1), driver_id: D1, kind: "arrived_drop", method: null, reason: null, created_at: ist(PAST, "09:35") });
    t("delivery_events").push({ id: ++eventId, delivery_id: delivery(1), order_id: order(1), driver_id: D2, kind: "offered", method: null, reason: "other rider's row", created_at: ist(PAST, "08:50") });
    const d = await x.getRiderHistoryDetail(D1, order(1), { earnings: true });
    assert.ok(d);
    assert.equal(d.outcome, "delivered");
    assert.deepEqual(d.items, [{ name: "Paneer roll", qty: 2 }, { name: "Cola", qty: 1 }]);
    assert.deepEqual(d.timeline.map((e) => e.kind), ["accepted", "picked_up", "arrived_drop", "delivered"]);
    assert.ok(!JSON.stringify(d.timeline).includes("other rider"), "the timeline is the rider's own events");
    assert.equal(d.proofPhotoUrl?.includes(`${delivery(1)}/proof.jpg`), true);
    assert.deepEqual(mode.signedFor, [{ path: `delivery-proofs/${delivery(1)}/proof.jpg`, expiresIn: 600 }], "signed for ten minutes");
    assert.ok(!JSON.stringify(d).includes("Secret Street"));
    assert.equal((await x.getRiderHistoryDetail(D1, order(7)))?.proofPhotoUrl, null, "no photo, no link");
    assert.equal(await x.getRiderHistoryDetail(D1, order(11)), null, "another rider's order is not found");
    assert.equal(await x.getRiderHistoryDetail(D2, order(1)), null, "...and neither is this one for them");
    assert.equal(await x.getRiderHistoryDetail(D1, order(6)), null, "an in-flight delivery has no history yet");
    assert.equal(await x.getRiderHistoryDetail(D1, order(404)), null);
    // reassigned away: the new rider's photo is not this rider's proof
    const theirs = t("deliveries").find((d2) => d2.id === delivery(4))!;
    theirs.pod_photo_path = `${delivery(4)}/theirs.jpg`;
    theirs.status = "delivered";
    mode.signedFor.length = 0;
    const away = await x.getRiderHistoryDetail(D1, order(4));
    assert.equal(away?.outcome, "reassigned");
    assert.equal(away?.proofPhotoUrl, null);
    assert.equal(mode.signedFor.length, 0);
  });

  await group("data: Performance - targets, rates, times, hours, months, ratings", async () => {
    reset();
    seedShops();
    // 10 March: three delivered (30, 40 and 50 min accept -> deliver), one failed, one cancelled
    const run = (n: number, hh: string, mins: number, end: string) => {
      seedOrder(n);
      seedDelivery(n, D1, end, { delivery_method: "code" });
      seedEvent(D1, n, "accepted", ist(PAST, `${hh}:00`));
      seedEvent(D1, n, "picked_up", ist(PAST, `${hh}:10`));
      seedEvent(D1, n, end, new Date(Date.parse(ist(PAST, `${hh}:00`)) + mins * 60_000).toISOString(), end === "failed" ? { reason: "x" } : {});
    };
    run(1, "08", 30, "delivered");
    run(2, "09", 40, "delivered");
    run(3, "10", 50, "delivered");
    run(4, "11", 30, "failed");
    seedOrder(5);
    seedEvent(D1, 5, "accepted", ist(PAST, "12:00"));
    seedEvent(D1, 5, "cancelled", ist(PAST, "12:05"));
    // 5 accepted + 2 rejected + 1 lapsed offers -> 5 of 8 = 62.5 %
    seedEvent(D1, 90, "rejected", ist(PAST, "07:00"));
    seedEvent(D1, 91, "rejected", ist(PAST, "07:10"));
    seedEvent(D1, 92, "lapsed", ist(PAST, "07:20"));
    // a delivery across the year boundary for the month table
    seedOrder(6);
    seedDelivery(6, D1, "delivered", { delivery_method: "code" });
    seedEvent(D1, 6, "accepted", ist("2025-12-31", "23:50"));
    seedEvent(D1, 6, "picked_up", ist("2025-12-31", "23:55"));
    seedEvent(D1, 6, "delivered", ist("2026-01-01", "00:10"));
    // hours: Monday 4 h, today 3 h and an open shift since 14:00 (1 h so far)
    t("rider_shifts").push(
      { id: 1, driver_id: D1, started_at: ist("2026-03-09", "09:00"), ended_at: ist("2026-03-09", "13:00"), ended_by: "rider" },
      { id: 2, driver_id: D1, started_at: ist(PAST, "08:00"), ended_at: ist(PAST, "11:00"), ended_by: "rider" },
      { id: 3, driver_id: D1, started_at: ist(PAST, "14:00"), ended_at: null, ended_by: null },
      { id: 4, driver_id: D2, started_at: ist(PAST, "08:00"), ended_at: ist(PAST, "18:00"), ended_by: "rider" }
    );
    t("rider_ratings").push(
      { id: "q1", order_id: order(1), driver_id: D1, customer_id: "cust-secret-1", rating: 5, comment: "Fast and polite", created_at: ist(PAST, "09:00") },
      { id: "q2", order_id: order(2), driver_id: D1, customer_id: "cust-secret-2", rating: 4, comment: null, created_at: ist(PAST, "10:00") },
      { id: "q3", order_id: order(3), driver_id: D1, customer_id: "cust-secret-3", rating: 3, comment: "A bit late", created_at: ist("2026-03-09", "10:00") },
      { id: "qo", order_id: order(8), driver_id: D2, customer_id: "cust-secret-4", rating: 1, comment: "not mine", created_at: ist(PAST, "10:00") }
    );
    t("rider_incentive_rules").push(
      { id: "ru1", name: "Daily 8", period: "daily", target_deliveries: 8, bonus_amount: 50, window_start: null, window_end: null, starts_on: "2026-03-01", ends_on: null, active: true, created_at: "2026-03-01T00:00:00Z" },
      { id: "ru2", name: "Daily 12", period: "daily", target_deliveries: 12, bonus_amount: 90, window_start: null, window_end: null, starts_on: "2026-03-01", ends_on: null, active: true, created_at: "2026-03-01T00:00:01Z" },
      { id: "ru3", name: "Weekly 60", period: "weekly", target_deliveries: 60, bonus_amount: 500, window_start: null, window_end: null, starts_on: "2026-03-01", ends_on: null, active: true, created_at: "2026-03-01T00:00:02Z" }
    );
    seedEarning("e1", 1, D1, ist(PAST, "08:30"), 38);
    t("rider_adjustments").push({ id: "s1", driver_id: D1, kind: "salary", amount: 5000, reason: "December", order_id: null, effective_on: "2025-12-31", created_by: null, created_at: "2025-12-31T06:00:00Z", payout_id: null, reverses_earning_id: null });

    const p = await x.getRiderPerformance(D1, NOW, { settings, earnings: true });
    assert.deepEqual(p.daily, { target: 12, done: 3 }, "no admin default: the largest active daily rule");
    assert.deepEqual(p.weekly, { target: 60, done: 3 });
    assert.equal(p.avgAcceptToDeliverMin, 40, "(30 + 40 + 50) / 3");
    assert.equal(p.avgPickupToDeliverMin, 30, "(20 + 30 + 40) / 3");
    assert.equal(p.acceptanceRate, 62.5, "5 accepted of 8 offers");
    assert.equal(p.failedRate, 25, "1 of 4 delivered-or-failed");
    assert.equal(p.onlineHoursThisWeek, 8, "4 + 3 + 1 so far today; the other rider's shift is not counted");
    assert.equal(p.rating.average, 4);
    assert.equal(p.rating.count, 3);
    assert.deepEqual(p.rating.recent.map((r) => [r.rating, r.comment]), [[4, null], [5, "Fast and polite"], [3, "A bit late"]]);
    assert.equal(Object.keys(p.rating.recent[0]).sort().join(), "at,comment,rating");
    assert.ok(!JSON.stringify(p).includes("cust-secret"), "no customer id reaches the rider");
    assert.equal(p.months[0].month, "2026-03");
    assert.equal(p.months[11].month, "2025-04");
    const mar = p.months.find((m) => m.month === "2026-03")!;
    assert.deepEqual({ d: mar.delivered, f: mar.failed, c: mar.cancelled, a: mar.acceptanceRate, m: mar.avgDeliverMin, e: mar.earnings, h: mar.onlineHours }, { d: 3, f: 1, c: 1, a: 62.5, m: 40, e: 38, h: 8 });
    const jan = p.months.find((m) => m.month === "2026-01")!;
    assert.equal(jan.delivered, 1);
    assert.equal(jan.avgDeliverMin, 20);
    const dec = p.months.find((m) => m.month === "2025-12")!;
    assert.equal(dec.earnings, 5000, "the recorded salary is the month's money");
    assert.equal(dec.delivered, 0);
    // the admin's default targets win over the rules
    const withDefault = await x.getRiderPerformance(D1, NOW, { settings: { ...settings, riderDailyTarget: 10, riderWeeklyTarget: 55 }, earnings: false });
    assert.deepEqual(withDefault.daily, { target: 10, done: 3 });
    assert.deepEqual(withDefault.weekly, { target: 55, done: 3 });
    assert.ok(withDefault.months.every((m) => m.earnings === null), "no money when earnings is off");
    assert.ok(reads("rider_ratings").every((r) => r.query.includes(`driver_id=eq.${D1}`)));
    assert.ok(reads("rider_ratings").every((r) => !r.query.includes("customer_id")), "customer_id is never selected");
  });

  await group("data: Performance before 0084 shows no ratings; before 0083 no rule-based target and no money", async () => {
    reset();
    seedShops();
    seedDelivered(1, PAST, "09");
    mode.missingTables.add("rider_ratings");
    for (const tbl of LEDGER_TABLES) mode.missingTables.add(tbl);
    const p = await x.getRiderPerformance(D1, NOW, { settings: { ...settings, riderDailyTarget: 7 }, earnings: true });
    assert.deepEqual(p.rating, { average: null, count: 0, recent: [] });
    assert.deepEqual(p.daily, { target: 7, done: 1 });
    assert.deepEqual(p.weekly, { target: 0, done: 1 });
    assert.ok(p.months.every((m) => m.earnings === null));
  });

  await group("data: ratings - average, count, 20 a page by keyset, no customer, only this rider's", async () => {
    reset();
    for (let i = 1; i <= 45; i++) {
      t("rider_ratings").push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, order_id: order(i), driver_id: D1, customer_id: `cust-secret-${i}`,
        rating: (i % 5) + 1, comment: i % 2 ? `Comment ${i}` : null, created_at: new Date(Date.parse(ist("2026-02-01", "08:00")) + i * 3_600_000).toISOString(),
      });
    }
    t("rider_ratings").push({ id: "00000000-0000-4000-8000-0000000000ff", order_id: order(500), driver_id: D2, customer_id: "x", rating: 1, comment: "not mine", created_at: ist("2026-03-01", "08:00") });
    const first = await x.getRiderRatings(D1, {});
    assert.equal(first.count, 45);
    assert.equal(first.average, 3, "nine full cycles of 2, 3, 4, 5, 1");
    assert.equal(first.items.length, 20);
    assert.ok(first.nextCursor);
    const second = await x.getRiderRatings(D1, { cursor: first.nextCursor });
    const third = await x.getRiderRatings(D1, { cursor: second.nextCursor });
    assert.equal(second.items.length, 20);
    assert.equal(third.items.length, 5);
    assert.equal(third.nextCursor, null);
    const all = [...first.items, ...second.items, ...third.items];
    assert.equal(new Set(all.map((i) => i.at)).size, 45);
    assert.deepEqual(all.map((i) => i.at), [...all.map((i) => i.at)].sort().reverse());
    assert.ok(all.every((i) => Object.keys(i).sort().join() === "at,comment,rating"), "rating, comment, time - nothing that says who");
    assert.ok(!JSON.stringify([first, second, third]).includes("cust-secret"));
    assert.ok(!JSON.stringify(all).includes("not mine"));
    await assert.rejects(x.getRiderRatings(D1, { cursor: "zzz" }), inputError("invalid_cursor"));
    reset();
    mode.missingTables.add("rider_ratings");
    await assert.rejects(x.getRiderRatings(D1, {}), (e: unknown) => isRiderSchemaPending(e), "before 0084 the ratings route fails closed");
  });

  await group("data: the admin's view of a rider's ratings carries the order code", async () => {
    reset();
    t("rider_ratings").push(
      { id: "q1", order_id: order(1), driver_id: D1, customer_id: "cust-secret", rating: 5, comment: "Great", created_at: ist(PAST, "09:00") },
      { id: "q2", order_id: order(2), driver_id: D1, customer_id: "cust-secret", rating: 2, comment: null, created_at: ist(PAST, "10:00") }
    );
    const a = await x.getRiderRatingsForAdmin(D1);
    assert.equal(a.count, 2);
    assert.equal(a.average, 3.5);
    assert.deepEqual(a.recent.map((r) => [r.rating, r.comment, r.orderCode]), [[2, null, code(2)], [5, "Great", code(1)]]);
    assert.ok(!JSON.stringify(a).includes("cust-secret"));
    mode.missingTables.add("rider_ratings");
    assert.deepEqual(await x.getRiderRatingsForAdmin(D1), { average: null, count: 0, recent: [] }, "before 0084: no ratings yet");
  });

  await group("data: a database without 0081 fails closed (503 migration_pending), a failed read is a plain error", async () => {
    const runs: [string, () => Promise<unknown>][] = [
      ["dashboard", () => x.getRiderDashboard(D1, NOW, { settings })],
      ["history", () => x.getRiderHistory(D1, {})],
      ["detail", () => x.getRiderHistoryDetail(D1, order(1))],
      ["performance", () => x.getRiderPerformance(D1, NOW, { settings })],
    ];
    for (const [name, run] of runs) {
      reset();
      mode.missingTables.add("delivery_events");
      let caught: unknown = null;
      try {
        await run();
      } catch (e) {
        caught = e;
      }
      assert.ok(isRiderSchemaPending(caught), `${name} without delivery_events: ${String(caught)}`);
    }
    reset();
    mode.failReads.add("delivery_events");
    await assert.rejects(x.getRiderDashboard(D1, NOW, { settings }), (e: unknown) => !isRiderSchemaPending(e), "any other failure is a plain error (500)");
  });
}

// ---------------------------------------------------------------------------
// 3. the route contract (needs `npm run dev`)
// ---------------------------------------------------------------------------
const SOME_ORDER = "00000000-0000-4000-8000-00000000abcd";
const ROUTES = [
  "/api/rider/dashboard",
  "/api/rider/history",
  `/api/rider/history/${SOME_ORDER}`,
  "/api/rider/performance",
  "/api/rider/ratings",
];

async function get(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
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
  for (const route of ROUTES) {
    const res = await get(route);
    check(`no cookie -> 401  GET ${route}`, res.status === 401 && res.json?.error === "unauthenticated", res);
  }

  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    for (const route of ROUTES) {
      const res = await get(route, cookie);
      check(`customer -> 403 not_rider  GET ${route}`, res.status === 403 && res.json?.error === "not_rider", res);
    }
  } else {
    skip("customer 403 checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }

  if (!RIDER_EMAIL || !RIDER_PASSWORD) {
    skip("rider checks (400 invalid_*, 404 not_found, 200 shapes or 503 migration_pending): QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const expect = async (path: string, status: number, error: string) => {
    const res = await get(path, cookie);
    if (res.status === 403 && res.json?.error === "feature_disabled") return skip(`${path}: a feature switch is off for the QA rider`);
    check(`${path} -> ${status} ${error}`, res.status === status && res.json?.error === error, res);
  };
  await expect("/api/rider/history?from=2025-1-01", 400, "invalid_date");
  await expect("/api/rider/history?from=2025-03-02&to=2025-03-01", 400, "invalid_range");
  await expect("/api/rider/history?outcome=nope", 400, "invalid_outcome");
  await expect("/api/rider/history?cursor=zzz", 400, "invalid_cursor");
  await expect("/api/rider/ratings?cursor=zzz", 400, "invalid_cursor");
  await expect("/api/rider/history/not-a-uuid", 404, "not_found");
  for (const route of ROUTES) {
    const res = await get(route, cookie);
    if (res.status === 503) {
      check(`GET ${route} before 0081/0084 -> 503 migration_pending`, res.json?.error === "migration_pending", res);
    } else if (res.status === 403 && res.json?.error === "feature_disabled") {
      skip(`GET ${route}: a feature switch is off for the QA rider`);
    } else if (route.includes(SOME_ORDER)) {
      check(`GET ${route} -> 404 not_found (not this rider's order)`, res.status === 404 && res.json?.error === "not_found", res);
    } else {
      check(`GET ${route} -> 200`, res.status === 200, res);
    }
  }
}

async function main(): Promise<void> {
  console.log("-- 1. pure rules");
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
