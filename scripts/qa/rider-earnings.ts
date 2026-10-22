/**
 * QA — rider money (Phase 3 Task 2): the pure maths, the data layer against a
 * fake PostgREST, and the route contract.
 *
 *   npm run test:rider-earnings   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD          a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account
 *
 * Three tiers:
 *
 *   1. Pure (`lib/rider/earnings-math.ts`). The salary model: a ₹0 delivery
 *      is not pay (hidden from records and statements, no per-delivery average,
 *      reconciliation unchanged). The proof's payout scenarios (D2, D3, D7, D8) are
 *      mirrored as fixtures: records, the summary (pending may be negative),
 *      and statement reconciliation — opening pending + earned − paid = closing
 *      pending — including ruling P3-R6's reversal attachment. Date-range
 *      validation and incentive progress. Always run.
 *   2. The data layer (`data-access/rider-earnings.ts`) against an in-memory
 *      PostgREST: paging, the rider filter, cursors, statements, payouts,
 *      progress, award pushes (claimed once), and a database without 0083
 *      (RiderSchemaPendingError -> 503 migration_pending). Always run.
 *   3. Route contract against the dev server: no cookie is 401 on all five
 *      routes; a customer is 403; a rider's malformed dates are 400. The
 *      session-dependent checks SKIP without QA accounts, and everything SKIPs
 *      when the server is not running (ruling R2: no database has 0083).
 *
 * Never sends push/SMS/OTP and never writes live data: every ONESIGNAL variable
 * is removed before any module loads, the fake is the only thing written to,
 * and the five routes are GET-only.
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

// ---------------------------------------------------------------------------
// fixtures shared by the pure and data tiers
// ---------------------------------------------------------------------------
const D2 = "00000000-0000-4000-8000-0000000000d2";
const D8 = "00000000-0000-4000-8000-0000000000d8";
const OTHER = "00000000-0000-4000-8000-00000000beef";
const order = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
/** An IST wall-clock instant as ISO (UTC). */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

interface Fixture {
  earnings: Row[];
  awards: Row[];
  adjustments: Row[];
  payouts: Row[];
}

/** One earning row in the shape the data layer maps from `rider_earnings`. */
function earning(id: string, orderId: string, at: string, over: Row = {}): Row {
  return {
    id,
    deliveryId: `del-${id}`,
    orderId,
    earnedAt: at,
    baseFee: 20,
    distanceKm: 5,
    distanceSource: "road",
    billableKm: 3,
    distanceFee: 18,
    minTopup: 0,
    tipAmount: 0,
    tipInCash: true,
    amount: 38,
    payoutId: null,
    ...over,
  };
}
const award = (id: string, trigger: Row, amount: number, over: Row = {}): Row => ({
  id,
  ruleId: `rule-${id}`,
  ruleName: `Rule ${id}`,
  periodStart: trigger.earnedAt.slice(0, 10),
  amount,
  triggerEarningId: trigger.id,
  triggerDeliveryId: trigger.deliveryId,
  awardedAt: trigger.earnedAt,
  payoutId: null,
  ...over,
});
const adjustment = (id: string, kind: string, amount: number, on: string, over: Row = {}): Row => ({
  id,
  kind,
  amount,
  reason: `${kind} ${id}`,
  orderId: null,
  effectiveOn: on,
  payoutId: null,
  reversesEarningId: null,
  createdAt: `${on}T06:00:00.000Z`,
  ...over,
});
const payout = (id: string, amount: number, periodEnd: string, paidOn: string, over: Row = {}): Row => ({
  id,
  amount,
  method: "upi",
  reference: `UTR-${id}`,
  paidOn,
  periodEnd,
  note: null,
  createdAt: `${paidOn}T09:00:00.000Z`,
  ...over,
});
const attach = (rows: Row[], payoutId: string) => rows.forEach((r) => (r.payoutId = payoutId));

/**
 * D2 of the proof: four deliveries on 3 Nov (4 x 38), awards 100 + 50, bonus
 * 25, deduction 10 (with an order: it shows on that order's record), adjustment
 * -2.5, salary 5000 on 1 Dec; 11 Nov 23:30 IST and 12 Nov 00:30 IST (11 Nov in
 * UTC). Payout P1 up to 11 Nov = 352.5, paid 12 Nov.
 */
function d2(withLater = false): Fixture {
  const e = [
    earning("e1", order(1), ist("2025-11-03", "10:00")),
    earning("e2", order(2), ist("2025-11-03", "11:00")),
    // A ₹15 COD tip: shown, not in the amount (the proof's 38).
    earning("e3", order(3), ist("2025-11-03", "12:00"), { tipAmount: 15, tipInCash: true }),
    earning("e4", order(4), ist("2025-11-03", "13:00"), { distanceSource: "estimate" }),
    earning("inLate", order(5), ist("2025-11-11", "23:30")),
    earning("outEarly", order(6), ist("2025-11-12", "00:30")),
  ];
  const a = [award("a100", e[2], 100), award("a50", e[3], 50)];
  const j = [
    adjustment("bonus", "bonus", 25, "2025-11-03"),
    adjustment("ded", "deduction", 10, "2025-11-06", { orderId: order(2) }),
    adjustment("adj", "adjustment", -2.5, "2025-11-07"),
    adjustment("salary", "salary", 5000, "2025-12-01"),
  ];
  const p1 = payout("p1", 352.5, "2025-11-11", "2025-11-12");
  attach([...e.slice(0, 5), ...a, j[0], j[1], j[2]], "p1");
  const payouts = [p1];
  if (withLater) {
    payouts.push(payout("p2", 5038, "2025-12-01", "2025-12-01"));
    attach([e[5], j[3]], "p2");
  }
  return { earnings: e, awards: a, adjustments: j, payouts };
}

/**
 * The salaried fleet: the rate card is ₹0, so every delivery earns ₹0 (z1, z2,
 * z3; z3 was corrected, which wrote a ₹0 reversal); one delivery that did pay
 * ₹38; a ₹30,000 salary entry.
 */
function zeroLedger(): Fixture {
  const zero = { baseFee: 0, distanceFee: 0, billableKm: 0, minTopup: 0, amount: 0 };
  const e = [
    earning("z1", order(91), ist("2025-11-03", "10:00"), zero),
    earning("z2", order(92), ist("2025-11-04", "10:00"), zero),
    earning("z3", order(93), ist("2025-11-05", "10:00"), zero),
    earning("real", order(94), ist("2025-11-06", "10:00")),
  ];
  const j = [
    adjustment("z3-rev", "adjustment", 0, "2025-11-05", { orderId: order(93), reversesEarningId: "z3" }),
    adjustment("sal", "salary", 30000, "2025-11-01"),
  ];
  return { earnings: e, awards: [], adjustments: j, payouts: [] };
}

/** D3: five window-day earnings (5 x 38) + award 70, and a deduction of 10000. */
function d3(): Fixture {
  const e = [1, 2, 3, 4, 5].map((n) => earning(`w${n}`, order(30 + n), ist("2025-11-04", `1${n}:00`)));
  return {
    earnings: e,
    awards: [award("a70", e[4], 70)],
    adjustments: [adjustment("big", "deduction", 10000, "2025-11-04")],
    payouts: [],
  };
}

/** D7: earned + award 10, corrected out (reversed) and re-earned; one payout 48. */
function d7(): Fixture {
  const a1 = earning("a1", order(70), ist("2025-12-15", "10:00"));
  const a2 = earning("a2", order(70), ist("2025-12-20", "09:00"), { deliveryId: a1.deliveryId });
  const aw = award("aw10", a1, 10);
  const rev = adjustment("rev-a1", "adjustment", -38, "2025-12-20", {
    orderId: order(70),
    reversesEarningId: "a1",
    reason: `Delivery ${order(70).slice(0, 8).toUpperCase()} corrected after delivery`,
  });
  const p = payout("p7", 48, "2025-12-20", "2025-12-20");
  attach([a1, a2, aw, rev], "p7");
  return { earnings: [a1, a2], awards: [aw], adjustments: [rev], payouts: [p] };
}

/**
 * D8 (P3-R6): Y and Z on 16 Dec; Y reversed on 20 Dec; a payout up to 16 Dec,
 * paid 16 Dec, pays only Z (38) and attaches Y and Y's reversal; Z reversed on
 * 21 Dec after being paid -> -38 pending (an honest debt).
 */
function d8(): Fixture {
  const y = earning("y", order(81), ist("2025-12-16", "10:00"));
  const z = earning("z", order(82), ist("2025-12-16", "11:00"));
  const yRev = adjustment("rev-y", "adjustment", -38, "2025-12-20", { orderId: order(81), reversesEarningId: "y" });
  const zRev = adjustment("rev-z", "adjustment", -38, "2025-12-21", { orderId: order(82), reversesEarningId: "z" });
  const p = payout("p8", 38, "2025-12-16", "2025-12-16");
  attach([y, z, yRev], "p8");
  return { earnings: [y, z], awards: [], adjustments: [yRev, zRev], payouts: [p] };
}

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const m = await import("../../src/lib/rider/earnings-math");

  await group("salary model: a ₹0 delivery is not pay (isZeroDelivery) and a ₹0 ledger has no per-delivery average", () => {
    const f = zeroLedger();
    const recs = m.buildRecords(f);
    const zero = recs.filter((r) => m.isZeroDelivery(r));
    assert.deepEqual(zero.map((r) => r.id).sort(), ["z1", "z2", "z3", "z3-rev"], "₹0 deliveries and the ₹0 reversal of one");
    assert.equal(m.isZeroDelivery(recs.find((r) => r.id === "sal")!), false, "salary is a real entry");
    assert.equal(m.isZeroDelivery(recs.find((r) => r.id === "real")!), false, "a delivery that paid something is shown");
    const s = m.summarize({ ...f, earnings: f.earnings.filter((e) => e.amount === 0) }, "2025-11-12");
    assert.equal(s.deliveriesCounted, 2, "z3 was reversed, so it is not live");
    assert.equal(s.perDeliveryAvg, null, "every live earning is ₹0: nothing to average");
    const mixed = m.summarize(f, "2025-11-12");
    assert.equal(mixed.perDeliveryAvg, 12.67, "one ₹38 delivery among two live ₹0 ones: still an average (38 / 3)");
    assert.equal(m.summarize({ earnings: [], awards: [], adjustments: [], payouts: [] }, "2025-11-12").perDeliveryAvg, null);
  });

  await group("salary model: reconciliation is unchanged by ₹0 rows", () => {
    const f = zeroLedger();
    const all = m.buildRecords(f);
    const shown = all.filter((r) => !m.isZeroDelivery(r));
    const a = m.reconcile(all, f.payouts, "2025-11-01", "2025-11-30");
    const b = m.reconcile(shown, f.payouts, "2025-11-01", "2025-11-30");
    assert.deepEqual(a, b, "₹0 rows do not move money");
    assert.equal(a.balanced, true);
  });

  await group("dates: IST day of an instant, Monday weeks, ranges <= 366 days", () => {
    assert.equal(m.istDay(ist("2025-11-12", "00:30")), "2025-11-12", "00:30 IST is still 11 Nov in UTC");
    assert.equal(m.istDay(ist("2025-11-11", "23:30")), "2025-11-11");
    assert.equal(m.istWeekStart("2025-11-16"), "2025-11-10", "Sunday belongs to the week from Monday 10 Nov");
    assert.equal(m.istWeekStart("2025-11-17"), "2025-11-17", "Monday starts a week");
    assert.equal(m.istMonthStart("2025-11-17"), "2025-11-01");
    assert.equal(m.addDays("2025-12-31", 1), "2026-01-01");
    assert.deepEqual(m.parseRange("2024-01-01", "2024-12-31"), { ok: true, from: "2024-01-01", to: "2024-12-31" }, "a leap year is 366 days");
    assert.deepEqual(m.parseRange("2025-01-01", "2026-01-01"), { ok: true, from: "2025-01-01", to: "2026-01-01" }, "366 days");
    assert.deepEqual(m.parseRange("2025-01-01", "2026-01-02"), { ok: false, error: "invalid_range" }, "367 days");
    assert.deepEqual(m.parseRange("2025-03-02", "2025-03-01"), { ok: false, error: "invalid_range" }, "to before from");
    assert.deepEqual(m.parseRange("2025-02-30", "2025-03-01"), { ok: false, error: "invalid_date" }, "no 30 Feb");
    assert.deepEqual(m.parseRange("2025-3-01", "2025-03-02"), { ok: false, error: "invalid_date" }, "YYYY-MM-DD only");
    assert.deepEqual(m.parseRange("2025-03-01T00:00", "2025-03-02"), { ok: false, error: "invalid_date" });
    assert.deepEqual(m.parseRange("2025-03-01", "2025-03-01"), { ok: true, from: "2025-03-01", to: "2025-03-01" });
  });

  await group("records: award and deduction on the delivery record, every kind listed once", () => {
    const f = d2(true);
    const recs = m.buildRecords(f);
    assert.equal(recs.length, 6 + 2 + 4, "6 deliveries, 2 incentives, 4 adjustments");
    const byId = new Map(recs.map((r) => [r.id, r]));
    const e3 = byId.get("e3")!;
    assert.equal(e3.kind, "delivery");
    assert.equal(e3.incentive, 100, "the award that e3 triggered rides on its record");
    assert.equal(e3.orderCode, `#${order(3).slice(0, 8).toUpperCase()}`);
    assert.equal(e3.distanceSource, "road");
    assert.equal(e3.status, "paid");
    assert.equal(e3.settledOn, "2025-11-12");
    assert.equal(e3.reference, "UTR-p1");
    const e2 = byId.get("e2")!;
    assert.equal(e2.deduction, 10, "the deduction with order 2 shows on order 2's record");
    assert.equal(e2.amount, 38, "...without changing what the delivery itself earned");
    const ded = byId.get("ded")!;
    assert.equal(ded.kind, "deduction");
    assert.equal(ded.amount, -10, "a deduction record's amount is its signed effect");
    assert.equal(ded.deduction, 10);
    assert.equal(ded.orderId, order(2));
    const inc = byId.get("a100")!;
    assert.equal(inc.kind, "incentive");
    assert.equal(inc.amount, 100);
    assert.equal(inc.incentive, 100);
    assert.equal(inc.date, "2025-11-03", "an award is dated by the earning that reached the target");
    assert.equal(inc.orderId, order(3));
    assert.equal(inc.note, "Rule a100");
    assert.equal(byId.get("outEarly")!.date, "2025-11-12", "IST date, not UTC");
    assert.equal(byId.get("e4")!.distanceSource, "estimate", "P3-R2: an estimated distance is labelled");
    assert.equal(byId.get("salary")!.kind, "salary");
    assert.equal(byId.get("salary")!.status, "paid");
    assert.equal(byId.get("adj")!.amount, -2.5);
    const sum = recs.reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    assert.equal(sum, 5390.5, "records sum to everything paid (352.5 + 5038)");
    assert.deepEqual(recs.map((r) => r.date), [...recs.map((r) => r.date)].sort().reverse(), "newest first");
  });

  await group("records: a reversal is an adjustment linked to its order; the earning shows, marked reversed (P3-R4)", () => {
    const recs = m.buildRecords(d7());
    const a1 = recs.find((r) => r.id === "a1")!;
    const a2 = recs.find((r) => r.id === "a2")!;
    const rev = recs.find((r) => r.id === "rev-a1")!;
    assert.equal(a1.reversed, true);
    assert.equal(a2.reversed, false);
    assert.equal(rev.kind, "adjustment");
    assert.equal(rev.amount, -38);
    assert.equal(rev.orderId, order(70));
    assert.equal(rev.orderCode, `#${order(70).slice(0, 8).toUpperCase()}`);
    assert.equal(rev.reversesId, "a1");
    assert.match(rev.note ?? "", /corrected after delivery/);
    assert.equal(a1.incentive, 10, "the award stays on the record that triggered it");
  });

  await group("summary: D2 at 12 Nov 11:30 IST (before the 1 Dec payout)", () => {
    const s = m.summarize(d2(false), "2025-11-12");
    assert.equal(s.today, 38, "today: the 00:30 IST delivery");
    assert.equal(s.week, 76, "week from Mon 10 Nov: 11 Nov 23:30 + 12 Nov 00:30");
    assert.equal(s.month, 6 * 38 + 150 + 25 - 10 - 2.5, "month: every ledger entry dated in November (the 1 Dec salary is not yet)");
    assert.equal(s.total, 6 * 38 + 150 + 25 - 10 - 2.5 + 5000, "total: every non-reversed entry ever, salary included");
    assert.equal(s.deliveriesCounted, 6);
    assert.equal(s.perDeliveryAvg, 38);
    assert.equal(s.incentives, 150);
    assert.equal(s.bonuses, 25);
    assert.equal(s.deductions, 10);
    assert.equal(s.adjustments, -2.5);
    assert.equal(s.salary, 5000);
    assert.equal(s.paid, 352.5);
    assert.equal(s.pending, 38 + 5000, "pending = everything unattached");
    assert.deepEqual(s.lastPayout, { amount: 352.5, paidOn: "2025-11-12", reference: "UTR-p1" });
    assert.equal(
      Math.round((s.total - s.paid) * 100) / 100,
      s.pending,
      "the figures net: total (every entry) − paid = pending"
    );
  });

  await group("summary: a salaried rider's period figures are the signed sum of every non-reversed ledger entry", () => {
    const today = "2025-11-12"; // Wednesday; the week starts Mon 10 Nov
    const none = { earnings: [], awards: [], adjustments: [], payouts: [] };
    const sal = (id: string, amount: number, on: string) => adjustment(id, "salary", amount, on);

    // Salary only: nothing but one ledger entry recorded today.
    const s = m.summarize({ ...none, adjustments: [sal("sal", 15000, today)] }, today);
    assert.deepEqual([s.today, s.week, s.month, s.total], [15000, 15000, 15000, 15000], "salary shows in every period");
    assert.equal(s.salary, 15000, "the tile is unchanged");
    assert.equal(s.pending, 15000);

    // Periods: salary on the 11th (last week), 3rd (earlier this month), 31 Oct.
    const p = m.summarize(
      { ...none, adjustments: [sal("a", 100, today), sal("b", 20, "2025-11-09"), sal("c", 3, "2025-11-03"), sal("d", 1, "2025-10-31")] },
      today
    );
    assert.deepEqual([p.today, p.week, p.month, p.total], [100, 100, 123, 124], "IST days, Monday weeks, calendar month, ever");

    // Every kind counts, signed: bonus +, adjustment (signed) +/-, deduction -.
    const k = m.summarize(
      {
        ...none,
        adjustments: [
          sal("sal", 15000, today),
          adjustment("bon", "bonus", 500, today),
          adjustment("adj-", "adjustment", -75.5, today),
          adjustment("adj+", "adjustment", 20, today),
          adjustment("ded", "deduction", 1200, today),
        ],
      },
      today
    );
    assert.equal(k.today, 15000 + 500 - 75.5 + 20 - 1200, "a deduction reduces the figures");
    assert.equal(k.today, 14244.5);
    assert.deepEqual([k.week, k.month, k.total], [14244.5, 14244.5, 14244.5]);
    assert.equal(k.deductions, 1200, "the tiles are unchanged: a positive deduction total");
    assert.equal(k.adjustments, -55.5);
    assert.equal(k.bonuses, 500);

    // ₹0 delivery rows (the salaried rate card) add nothing; delivery earnings and awards still count.
    const z = m.summarize(
      {
        earnings: [
          earning("z1", order(1), ist(today, "10:00"), { amount: 0 }),
          earning("r1", order(2), ist(today, "11:00")),
        ],
        awards: [award("aw", earning("r1", order(2), ist(today, "11:00")), 10)],
        adjustments: [sal("sal", 15000, today)],
        payouts: [],
      },
      today
    );
    assert.deepEqual([z.today, z.total], [15048, 15048], "salary + ₹38 delivery + ₹10 award");

    // A reversed earning and its reversal both leave the periods and net to zero, even on different days.
    const e = earning("rv", order(3), ist("2025-11-10", "10:00"));
    const rev = adjustment("rv-rev", "adjustment", -38, today, { orderId: order(3), reversesEarningId: "rv" });
    const r = m.summarize({ ...none, earnings: [e], adjustments: [rev, sal("sal", 15000, today)] }, today);
    assert.deepEqual([r.today, r.week, r.month, r.total], [15000, 15000, 15000, 15000], "the pair is out of every period");
    assert.equal(r.deliveriesCounted, 0);
    assert.equal(r.pending, 15000, "and nets to zero in pending");
    const only = m.summarize({ ...none, earnings: [e], adjustments: [rev] }, today);
    assert.deepEqual([only.today, only.week, only.month, only.total], [0, 0, 0, 0]);
    assert.equal(Object.is(only.today, -0), false, "no negative zero");
  });

  await group("statement: earned counts every ledger entry and opening + earned − paid = closing for a salaried rider", () => {
    const e = earning("rv", order(3), ist("2025-11-10", "10:00"));
    const f = {
      earnings: [e, earning("z1", order(4), ist("2025-11-11", "10:00"), { amount: 0 })],
      awards: [],
      adjustments: [
        adjustment("sal", "salary", 15000, "2025-11-12"),
        adjustment("bon", "bonus", 500, "2025-11-12"),
        adjustment("ded", "deduction", 1200, "2025-11-14"),
        adjustment("rv-rev", "adjustment", -38, "2025-11-13", { orderId: order(3), reversesEarningId: "rv" }),
      ],
      payouts: [payout("p1", 15462, "2025-11-12", "2025-11-12")],
    };
    // The payout pays the 10th earning, the reversal is later (unattached), salary + bonus attached.
    attach([e, f.adjustments[0], f.adjustments[1]], "p1");
    f.payouts[0].amount = 38 + 15000 + 500;
    const recs = m.buildRecords(f);
    const ranges: [string, string][] = [["2025-11-01", "2025-11-30"], ["2025-11-12", "2025-11-12"], ["2025-11-13", "2025-11-30"], ["2025-11-01", "2025-11-11"], ["2025-11-10", "2025-11-14"]];
    for (const [from, to] of ranges) {
      const r = m.reconcile(recs, f.payouts, from, to);
      assert.ok(r.balanced, `${from}..${to}: ${JSON.stringify(r)}`);
    }
    const nov = m.reconcile(recs, f.payouts, "2025-11-01", "2025-11-30");
    assert.equal(nov.earned, 15000 + 500 - 1200, "salary, bonus and the deduction; the reversed pair nets to zero");
    // The statement's earned over a range holding every dated entry = the summary's total for the same ledger.
    const s = m.summarize(f, "2025-11-30");
    assert.equal(nov.earned, s.total, "statement earned (whole period) equals the summary total");
    assert.equal(s.total - s.paid, s.pending);
    assert.equal(nov.closingPending, s.pending);
  });

  await group("summary: pending can be negative (a deduction larger than everything — Review Focus 4)", () => {
    const s = m.summarize(d3(), "2025-11-05");
    assert.equal(s.total, 5 * 38 + 70 - 10000, "the deduction is in the total");
    assert.equal(s.paid, 0);
    assert.equal(s.pending, 260 - 10000);
    assert.equal(s.lastPayout, null);
    const z = m.summarize({ earnings: [], awards: [], adjustments: [], payouts: [] }, "2025-11-05");
    assert.equal(z.perDeliveryAvg, null, "no deliveries: no average");
    assert.equal(z.pending, 0);
  });

  await group("summary nets reversals: D7 (re-earned, award once) and D8 (paid then reversed)", () => {
    const s7 = m.summarize(d7(), "2025-12-20");
    assert.equal(s7.total, 38 + 10, "one live earning + the award");
    assert.equal(s7.deliveriesCounted, 1, "the reversed earning is not counted");
    assert.equal(s7.adjustments, 0, "a reversal is not an admin adjustment");
    assert.equal(s7.paid, 48);
    assert.equal(s7.pending, 0);
    const s8 = m.summarize(d8(), "2025-12-21");
    assert.equal(s8.total, 0);
    assert.equal(s8.deliveriesCounted, 0);
    assert.equal(s8.perDeliveryAvg, null);
    assert.equal(s8.paid, 38);
    assert.equal(s8.pending, -38, "Z's reversal after it was paid: an honest debt");
    for (const s of [s7, s8]) {
      assert.equal(Math.round((s.total - s.paid) * 100) / 100, s.pending);
    }
  });

  await group("statement reconciles: D2 across the 12 Nov payout", () => {
    const f = d2(true);
    const recs = m.buildRecords(f);
    const nov = m.reconcile(recs, f.payouts, "2025-11-01", "2025-11-30");
    assert.equal(nov.openingPending, 0);
    assert.equal(nov.earned, 6 * 38 + 150 + 25 - 10 - 2.5);
    assert.equal(nov.paid, 352.5);
    assert.equal(nov.closingPending, 38, "the 12 Nov delivery is pending at the end of November");
    assert.equal(nov.balanced, true);
    const after = m.reconcile(recs, f.payouts, "2025-11-12", "2025-12-31");
    assert.equal(after.openingPending, 352.5, "everything up to 11 Nov was still owed on the 11th");
    assert.equal(after.earned, 38 + 5000);
    assert.equal(after.paid, 352.5 + 5038);
    assert.equal(after.closingPending, 0);
    assert.equal(after.balanced, true);
    const dayOf = m.reconcile(recs, f.payouts, "2025-11-12", "2025-11-12");
    assert.equal(dayOf.openingPending + dayOf.earned - dayOf.paid, dayOf.closingPending);
    assert.equal(dayOf.closingPending, 38);
  });

  await group("statement reconciles with reversals and the P3-R6 attachment rule (D7, D8)", () => {
    for (const [name, f, ranges] of [
      ["D7", d7(), [["2025-12-01", "2025-12-31"], ["2025-12-15", "2025-12-15"], ["2025-12-16", "2025-12-20"]]],
      ["D8", d8(), [["2025-12-01", "2025-12-16"], ["2025-12-17", "2025-12-31"], ["2025-12-16", "2025-12-20"], ["2025-12-01", "2025-12-31"]]],
    ] as const) {
      const recs = m.buildRecords(f);
      for (const [from, to] of ranges) {
        const r = m.reconcile(recs, f.payouts, from, to);
        assert.ok(r.balanced, `${name} ${from}..${to}: ${JSON.stringify(r)}`);
      }
    }
    const f = d8();
    const recs = m.buildRecords(f);
    const yRev = recs.find((r) => r.id === "rev-y")!;
    assert.equal(yRev.date, "2025-12-16", "P3-R6: a reversal attached to a payout is dated no later than the payout's paid_on");
    assert.equal(recs.find((r) => r.id === "rev-z")!.date, "2025-12-21", "an unattached reversal keeps its own date");
    const dec = m.reconcile(recs, f.payouts, "2025-12-01", "2025-12-16");
    assert.deepEqual(
      { o: dec.openingPending, e: dec.earned, p: dec.paid, c: dec.closingPending },
      { o: 0, e: 38, p: 38, c: 0 },
      "1–16 Dec: Y, Z and Y's reversal earned 38; the payout paid 38"
    );
    const later = m.reconcile(recs, f.payouts, "2025-12-17", "2025-12-31");
    assert.deepEqual({ o: later.openingPending, e: later.earned, p: later.paid, c: later.closingPending }, { o: 0, e: -38, p: 0, c: -38 });
    // Without the attachment rule (the reversal on its own 20 Dec date), the
    // 1–16 Dec statement would not add up: the rule is what makes it reconcile.
    const raw = recs.map((r) => (r.id === "rev-y" ? { ...r, date: "2025-12-20" } : r));
    assert.equal(m.reconcile(raw, f.payouts, "2025-12-01", "2025-12-16").balanced, false);
  });

  await group("statement: a payout whose attached rows do not add up is caught", () => {
    const f = d2(false);
    f.payouts[0].amount = 350; // 2.5 short of what it attached
    assert.equal(m.reconcile(m.buildRecords(f), f.payouts, "2025-11-01", "2025-11-30").balanced, false);
  });

  await group("incentive progress: today's and this week's counts, window, earned, rule dates", () => {
    const today = "2025-11-12"; // Wednesday
    const earnings = [
      earning("t1", order(91), ist(today, "10:00")),
      earning("t2", order(92), ist(today, "12:30")),
      earning("t3", order(93), ist(today, "14:59")),
      earning("t4", order(94), ist(today, "15:00")),
      earning("t5", order(95), ist("2025-11-10", "12:00")), // Monday
      earning("t6", order(96), ist("2025-11-09", "12:00")), // Sunday: last week
      earning("rv", order(97), ist(today, "13:00")),
    ];
    const reversed = new Set(["rv"]);
    const rules = [
      { id: "daily", name: "Daily 3", period: "daily", targetDeliveries: 3, bonusAmount: 100, windowStart: null, windowEnd: null, startsOn: "2025-11-01", endsOn: null, active: true },
      { id: "lunch", name: "Lunch rush", period: "daily", targetDeliveries: 3, bonusAmount: 40, windowStart: "12:00:00", windowEnd: "15:00:00", startsOn: "2025-11-01", endsOn: "2025-11-30", active: true },
      { id: "week", name: "Weekly 10", period: "weekly", targetDeliveries: 10, bonusAmount: 300, windowStart: null, windowEnd: null, startsOn: "2025-11-01", endsOn: null, active: true },
      { id: "late", name: "Started Tuesday", period: "weekly", targetDeliveries: 2, bonusAmount: 50, windowStart: null, windowEnd: null, startsOn: "2025-11-11", endsOn: null, active: true },
      { id: "ended", name: "Ended", period: "daily", targetDeliveries: 1, bonusAmount: 10, windowStart: null, windowEnd: null, startsOn: "2025-11-01", endsOn: "2025-11-11", active: true },
      { id: "off", name: "Off", period: "daily", targetDeliveries: 1, bonusAmount: 10, windowStart: null, windowEnd: null, startsOn: "2025-11-01", endsOn: null, active: false },
      { id: "future", name: "Future", period: "daily", targetDeliveries: 1, bonusAmount: 10, windowStart: null, windowEnd: null, startsOn: "2025-11-13", endsOn: null, active: true },
    ] as const;
    const awards = [{ ruleId: "daily", periodStart: today }];
    const p = m.incentiveProgress(rules as never, earnings as never, reversed, awards, today);
    assert.deepEqual(p.map((x) => x.ruleId), ["daily", "lunch", "week", "late"], "ended, inactive and not-yet-started rules are left out");
    const by = new Map(p.map((x) => [x.ruleId, x]));
    assert.deepEqual(by.get("daily"), { ruleId: "daily", name: "Daily 3", period: "daily", target: 3, done: 4, bonus: 100, window: null, endsOn: null, earned: true });
    assert.equal(by.get("lunch")!.done, 2, "12:30 and 14:59 count; 15:00 does not; the reversed one does not");
    assert.equal(by.get("lunch")!.window, "12:00–15:00");
    assert.equal(by.get("lunch")!.endsOn, "2025-11-30");
    assert.equal(by.get("lunch")!.earned, false);
    assert.equal(by.get("week")!.done, 5, "Mon–Wed: 4 today + Monday; Sunday is last week");
    assert.equal(by.get("late")!.done, 4, "a rule that started Tuesday does not count Monday");
  });
}

// ---------------------------------------------------------------------------
// 2. data layer against a fake PostgREST
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const mode = { missingTables: new Set<string>(), failReads: new Set<string>() };
const requests: { method: string; table: string; query: string }[] = [];
const t = (name: string): Row[] => (db[name] ??= []);
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingTables.clear();
  mode.failReads.clear();
  requests.length = 0;
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
    const table = url.pathname.replace("/rest/v1/", "");
    requests.push({ method: req.method ?? "", table, query: url.search });
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
    if (table === "rpc/obs_ingest") return send(200, null);
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
    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      const hit = t(table).filter((r) => matches(r, url));
      for (const row of hit) Object.assign(row, body);
      return send(200, hit);
    }
    if (req.method === "POST" && body) {
      const incoming = Array.isArray(body) ? body : [body];
      t(table).push(...incoming.map((r) => ({ ...r })));
      return send(201, incoming);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

/** Fixture rows -> the database rows they come from. */
function seed(driverId: string, f: Fixture, rules: Row[] = []): void {
  for (const e of f.earnings) {
    t("rider_earnings").push({
      id: e.id,
      delivery_id: e.deliveryId,
      attempt: 1,
      order_id: e.orderId,
      driver_id: driverId,
      earned_at: e.earnedAt,
      base_fee: e.baseFee,
      distance_km: e.distanceKm,
      distance_source: e.distanceSource,
      billable_km: e.billableKm,
      distance_fee: e.distanceFee,
      min_topup: e.minTopup,
      tip_amount: e.tipAmount,
      tip_in_cash: e.tipInCash,
      // PostgREST returns numeric as a JSON number, but a string must work too.
      amount: String(e.amount),
      payout_id: e.payoutId,
      created_at: e.earnedAt,
    });
  }
  for (const a of f.awards) {
    if (!t("rider_incentive_rules").some((r) => r.id === a.ruleId)) {
      t("rider_incentive_rules").push({ id: a.ruleId, name: a.ruleName, period: "daily", target_deliveries: 1, bonus_amount: a.amount, window_start: null, window_end: null, starts_on: "2025-01-01", ends_on: null, active: false, created_at: "2025-01-01T00:00:00Z" });
    }
    t("rider_incentive_awards").push({
      id: a.id,
      rule_id: a.ruleId,
      driver_id: driverId,
      period_start: a.periodStart,
      deliveries_count: 1,
      amount: a.amount,
      trigger_delivery_id: a.triggerDeliveryId,
      trigger_earning_id: a.triggerEarningId,
      awarded_at: a.awardedAt,
      notified_at: "2025-01-01T00:00:00Z",
      payout_id: a.payoutId,
    });
  }
  for (const j of f.adjustments) {
    t("rider_adjustments").push({
      id: j.id,
      driver_id: driverId,
      kind: j.kind,
      amount: j.amount,
      reason: j.reason,
      order_id: j.orderId,
      effective_on: j.effectiveOn,
      created_by: null,
      created_at: j.createdAt,
      payout_id: j.payoutId,
      reverses_earning_id: j.reversesEarningId,
    });
  }
  for (const p of f.payouts) {
    t("rider_payouts").push({
      id: p.id,
      driver_id: driverId,
      period_end: p.periodEnd,
      amount: p.amount,
      method: p.method,
      reference: p.reference,
      paid_on: p.paidOn,
      note: p.note,
      created_by: "admin",
      created_at: p.createdAt,
    });
  }
  t("rider_incentive_rules").push(...rules);
}

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const x = await import("../../src/lib/data-access/rider-earnings");
  const m = await import("../../src/lib/rider/earnings-math");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");

  /** Noise: another rider's rows, which must never show. */
  const seedOther = () => seed(OTHER, {
    earnings: [earning("o1", order(500), ist("2025-11-12", "09:00"), { amount: 999 })],
    awards: [],
    adjustments: [adjustment("o-ded", "deduction", 5, "2025-11-12")],
    payouts: [payout("o-p", 77, "2025-11-01", "2025-11-02")],
  });

  await group("data: summary over the fake equals the pure summary; another rider's rows never count", async () => {
    reset();
    seed(D2, d2(false));
    seedOther();
    const now = new Date(ist("2025-11-12", "11:30"));
    const s = await x.getEarningsSummary(D2, now);
    assert.deepEqual(s, m.summarize(d2(false), "2025-11-12"));
    const reads = requests.filter((r) => r.table.startsWith("rider_"));
    assert.ok(reads.every((r) => r.table === "rider_incentive_rules" || r.query.includes(`driver_id=eq.${D2}`)), "every ledger read is filtered to the rider");
  });

  await group("data: pages past PostgREST's 1000-row cap", async () => {
    reset();
    const many = Array.from({ length: 1205 }, (_, i) =>
      earning(`bulk-${String(i).padStart(5, "0")}`, order(1000 + i), new Date(Date.parse(ist("2025-10-01", "10:00")) + i * 60_000).toISOString(), { amount: 1 })
    );
    seed(D2, { earnings: many, awards: [], adjustments: [], payouts: [] });
    const s = await x.getEarningsSummary(D2, new Date(ist("2025-10-02", "10:00")));
    assert.equal(s.deliveriesCounted, 1205);
    assert.equal(s.total, 1205);
    assert.equal(s.pending, 1205);
  });

  await group("data: records — range, newest first, cursor paging, P3-R2 distanceSource", async () => {
    reset();
    seed(D2, d2(true));
    seedOther();
    const all = await x.listEarningRecords(D2, { from: "2025-11-01", to: "2025-12-31", limit: 100 });
    assert.equal(all.items.length, 12);
    assert.equal(all.nextCursor, null);
    assert.deepEqual(all.items, m.buildRecords(d2(true)), "the same records the pure builder makes");
    const nov3 = await x.listEarningRecords(D2, { from: "2025-11-03", to: "2025-11-03" });
    assert.deepEqual(nov3.items.map((r) => r.id).sort(), ["a100", "a50", "bonus", "e1", "e2", "e3", "e4"]);
    const first = await x.listEarningRecords(D2, { from: "2025-11-01", to: "2025-12-31", limit: 5 });
    assert.equal(first.items.length, 5);
    assert.ok(first.nextCursor);
    const second = await x.listEarningRecords(D2, { from: "2025-11-01", to: "2025-12-31", limit: 5, cursor: first.nextCursor });
    const third = await x.listEarningRecords(D2, { from: "2025-11-01", to: "2025-12-31", limit: 5, cursor: second.nextCursor });
    assert.equal(third.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items, ...third.items].map((r) => r.id), all.items.map((r) => r.id), "pages tile the list");
    assert.ok(all.items.some((r) => r.distanceSource === "estimate"));
    await assert.rejects(x.listEarningRecords(D2, { from: "2025-11-01", to: "2025-12-31", cursor: "nope" }), /invalid_cursor/);
  });

  await group("data: records default to the last 31 days (IST) when no range is given", async () => {
    reset();
    seed(D2, d2(true));
    const r = await x.listEarningRecords(D2, {}, new Date(ist("2025-12-05", "12:00")));
    assert.deepEqual(r.items.map((i) => i.id).sort(), ["adj", "ded", "inLate", "outEarly", "salary"], "5 Nov .. 5 Dec");
  });

  await group("data: a payout's item count leaves out the ₹0 rows it attached", async () => {
    reset();
    const f = zeroLedger();
    f.payouts = [payout("pz", 30038, "2025-11-30", "2025-11-30")];
    attach([...f.earnings, ...f.adjustments], "pz");
    seed(D2, f);
    const p = await x.listPayouts(D2);
    assert.equal(p.length, 1);
    assert.equal(p[0].items, 2, "the ₹38 delivery and the salary; z1-z3 and the ₹0 reversal are attached but not counted");
  });

  await group("data: ₹0 delivery rows are hidden by default and shown with hideZeroDeliveries: false", async () => {
    reset();
    seed(D2, zeroLedger());
    const range = { from: "2025-11-01", to: "2025-11-30", limit: 100 };
    const hidden = await x.listEarningRecords(D2, range);
    assert.deepEqual(hidden.items.map((r) => r.id).sort(), ["real", "sal"], "the ₹0 deliveries and the ₹0 reversal are not listed");
    const shown = await x.listEarningRecords(D2, { ...range, hideZeroDeliveries: false });
    assert.deepEqual(shown.items.map((r) => r.id).sort(), ["real", "sal", "z1", "z2", "z3", "z3-rev"]);
    const first = await x.listEarningRecords(D2, { ...range, limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor, "paging counts only what is shown");
    const second = await x.listEarningRecords(D2, { ...range, limit: 1, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
  });

  await group("data: the summary's per-delivery average is null on an all-₹0 ledger", async () => {
    reset();
    const f = zeroLedger();
    f.earnings = f.earnings.filter((e) => e.amount === 0);
    seed(D2, f);
    const s = await x.getEarningsSummary(D2, new Date(ist("2025-11-12", "11:30")));
    assert.equal(s.perDeliveryAvg, null);
    assert.equal(s.salary, 30000);
    assert.equal(s.deliveriesCounted, 2);
  });

  await group("data: a statement omits ₹0 delivery rows and still balances", async () => {
    reset();
    seed(D2, zeroLedger());
    const st = await x.getStatement(D2, "2025-11-01", "2025-11-30");
    assert.deepEqual(st.rows.map((r) => r.id), ["sal", "real"], "salary 1 Nov, then the ₹38 delivery; no ₹0 rows");
    assert.equal(st.openingPending, 0);
    assert.equal(st.earned, 30038);
    assert.equal(st.paid, 0);
    assert.equal(st.closingPending, 30038);
    assert.equal(st.openingPending + st.earned - st.paid, st.closingPending);
    assert.equal(st.rows.reduce((n, r) => n + r.amount, 0), st.earned, "the rows shown add up to the earned total");
  });

  await group("data: payouts — newest first, with the number of rows each settled", async () => {
    reset();
    seed(D2, d2(true));
    seedOther();
    const p = await x.listPayouts(D2);
    assert.deepEqual(p, [
      { id: "p2", amount: 5038, method: "upi", reference: "UTR-p2", paidOn: "2025-12-01", periodEnd: "2025-12-01", items: 2 },
      { id: "p1", amount: 352.5, method: "upi", reference: "UTR-p1", paidOn: "2025-11-12", periodEnd: "2025-11-11", items: 10 },
    ]);
  });

  await group("data: statement — header, reconciled totals, rows in range oldest first", async () => {
    reset();
    seed(D2, d2(true));
    seedOther();
    t("profiles").push({ id: D2, full_name: "Ravi Rider" });
    t("rider_profiles").push({ driver_id: D2, rider_code: "DR-0042" });
    const st = await x.getStatement(D2, "2025-11-01", "2025-11-30");
    assert.equal(st.riderCode, "DR-0042");
    assert.equal(st.name, "Ravi Rider");
    assert.equal(st.from, "2025-11-01");
    assert.equal(st.to, "2025-11-30");
    assert.equal(st.openingPending, 0);
    assert.equal(st.earned, 390.5);
    assert.equal(st.paid, 352.5);
    assert.equal(st.closingPending, 38);
    assert.equal(st.openingPending + st.earned - st.paid, st.closingPending);
    assert.equal(st.rows.length, 11, "everything dated in November");
    assert.deepEqual(st.rows.map((r) => r.date), [...st.rows.map((r) => r.date)].sort(), "oldest first");
    reset();
    seed(D8, d8());
    const s8 = await x.getStatement(D8, "2025-12-01", "2025-12-16");
    assert.deepEqual({ o: s8.openingPending, e: s8.earned, p: s8.paid, c: s8.closingPending }, { o: 0, e: 38, p: 38, c: 0 }, "P3-R6");
    assert.equal(s8.riderCode, null, "no rider_profiles row: no code");
  });

  await group("data: incentive progress reads active rules and this week's earnings", async () => {
    reset();
    const today = "2025-11-12";
    seed(D2, {
      earnings: [
        earning("t1", order(91), ist(today, "10:00")),
        earning("t2", order(92), ist(today, "12:30")),
        earning("t5", order(95), ist("2025-11-10", "12:00")),
        earning("t6", order(96), ist("2025-11-09", "12:00")),
      ],
      awards: [],
      adjustments: [],
      payouts: [],
    }, [
      { id: "daily", name: "Daily 2", period: "daily", target_deliveries: 2, bonus_amount: 50, window_start: null, window_end: null, starts_on: "2025-11-01", ends_on: null, active: true, created_at: "2025-11-01T00:00:00Z" },
      { id: "week", name: "Weekly 5", period: "weekly", target_deliveries: 5, bonus_amount: 200, window_start: null, window_end: null, starts_on: "2025-11-01", ends_on: null, active: true, created_at: "2025-11-02T00:00:00Z" },
      { id: "off", name: "Off", period: "daily", target_deliveries: 1, bonus_amount: 5, window_start: null, window_end: null, starts_on: "2025-11-01", ends_on: null, active: false, created_at: "2025-11-03T00:00:00Z" },
    ]);
    t("rider_incentive_awards").push({ id: "aw", rule_id: "daily", driver_id: D2, period_start: today, deliveries_count: 2, amount: 50, trigger_delivery_id: "del-t2", trigger_earning_id: "t2", awarded_at: ist(today, "12:30"), notified_at: null, payout_id: null });
    const p = await x.getIncentiveProgress(D2, new Date(ist(today, "18:00")));
    assert.deepEqual(p, [
      { ruleId: "daily", name: "Daily 2", period: "daily", target: 2, done: 2, bonus: 50, window: null, endsOn: null, earned: true },
      { ruleId: "week", name: "Weekly 5", period: "weekly", target: 5, done: 3, bonus: 200, window: null, endsOn: null, earned: false },
    ]);
  });

  await group("data: notifyNewIncentiveAwards pushes each new award once, then never again", async () => {
    reset();
    t("rider_incentive_rules").push({ id: "r1", name: "Lunch rush", active: true });
    t("rider_incentive_awards").push(
      { id: "n1", rule_id: "r1", driver_id: D2, period_start: "2025-11-12", amount: 40, awarded_at: "2025-11-12T07:00:00Z", notified_at: null, payout_id: null },
      { id: "n2", rule_id: "r1", driver_id: D2, period_start: "2025-11-11", amount: 40.5, awarded_at: "2025-11-11T07:00:00Z", notified_at: "2025-11-11T07:00:01Z", payout_id: null },
      { id: "n3", rule_id: "r1", driver_id: OTHER, period_start: "2025-11-12", amount: 99, awarded_at: "2025-11-12T07:00:00Z", notified_at: null, payout_id: null }
    );
    const pushed: string[] = [];
    const push = async (driverId: string, a: { name: string; amount: number }) => void pushed.push(`${driverId}:${a.name}:${a.amount}`);
    await x.notifyNewIncentiveAwards(D2, { push });
    assert.deepEqual(pushed, [`${D2}:Lunch rush:40`]);
    assert.ok(t("rider_incentive_awards").find((a) => a.id === "n1")!.notified_at, "stamped");
    assert.equal(t("rider_incentive_awards").find((a) => a.id === "n3")!.notified_at, null, "another rider's award is not touched");
    await x.notifyNewIncentiveAwards(D2, { push });
    assert.equal(pushed.length, 1, "a second call pushes nothing");
    // A long history of announced awards must not crowd a new one out of the batch.
    for (let i = 0; i < 12; i++) {
      t("rider_incentive_awards").push({ id: `old${i}`, rule_id: "r1", driver_id: D2, period_start: "2025-10-01", amount: 1, awarded_at: `2025-10-0${(i % 9) + 1}T07:00:00Z`, notified_at: "2025-10-10T00:00:00Z", payout_id: null });
    }
    t("rider_incentive_awards").push({ id: "n4", rule_id: "r1", driver_id: D2, period_start: "2025-11-13", amount: 60, awarded_at: "2025-11-13T07:00:00Z", notified_at: null, payout_id: null });
    await x.notifyNewIncentiveAwards(D2, { push });
    assert.deepEqual(pushed, [`${D2}:Lunch rush:40`, `${D2}:Lunch rush:60`], "only the new award, past twelve announced ones");
    await assert.rejects(x.listEarningRecords(D2, { from: "2025-11-01" }), /invalid_range/, "half a range is refused");
    mode.missingTables.add("rider_incentive_awards");
    await x.notifyNewIncentiveAwards(D2, { push }); // must not throw before 0083
    assert.equal(pushed.length, 2, "and before 0083 it does nothing");
  });

  await group("data: one failing push does not drop the awards after it (Task 2 review carry-in)", async () => {
    reset();
    t("rider_incentive_rules").push({ id: "r1", name: "Lunch rush", active: true });
    t("rider_incentive_awards").push(
      { id: "f1", rule_id: "r1", driver_id: D2, period_start: "2025-11-10", amount: 10, awarded_at: "2025-11-10T07:00:00Z", notified_at: null, payout_id: null },
      { id: "f2", rule_id: "r1", driver_id: D2, period_start: "2025-11-11", amount: 20, awarded_at: "2025-11-11T07:00:00Z", notified_at: null, payout_id: null },
      { id: "f3", rule_id: "r1", driver_id: D2, period_start: "2025-11-12", amount: 30, awarded_at: "2025-11-12T07:00:00Z", notified_at: null, payout_id: null }
    );
    const pushed: number[] = [];
    const push = async (_driverId: string, a: { name: string; amount: number }) => {
      if (a.amount === 20) throw new Error("push provider down");
      pushed.push(a.amount);
    };
    await x.notifyNewIncentiveAwards(D2, { push }); // must not throw
    assert.deepEqual(pushed, [10, 30], "the awards either side of the failure are still pushed");
  });

  await group("data: a statement still answers when the name cannot be read", async () => {
    reset();
    seed(D2, d2(true));
    mode.failReads.add("profiles");
    const st = await x.getStatement(D2, "2025-11-01", "2025-11-30");
    assert.equal(st.name, null, "no name, but the figures are true");
    assert.equal(st.earned, 390.5);
  });

  await group("data: a database without 0083 -> RiderSchemaPendingError (503 migration_pending)", async () => {
    const calls: Record<string, () => Promise<unknown>> = {
      summary: () => x.getEarningsSummary(D2),
      records: () => x.listEarningRecords(D2, { from: "2025-11-01", to: "2025-11-30" }),
      statement: () => x.getStatement(D2, "2025-11-01", "2025-11-30"),
      payouts: () => x.listPayouts(D2),
      incentives: () => x.getIncentiveProgress(D2),
    };
    // Which reads need which table (they all arrive together in 0083).
    const needs: Record<string, string[]> = {
      rider_earnings: ["summary", "records", "statement", "payouts", "incentives"],
      rider_adjustments: ["summary", "records", "statement", "payouts", "incentives"],
      rider_incentive_awards: ["summary", "records", "statement", "payouts", "incentives"],
      rider_payouts: ["summary", "records", "statement", "payouts"],
      rider_incentive_rules: ["incentives"],
    };
    for (const [table, names] of Object.entries(needs)) {
      for (const name of names) {
        reset();
        mode.missingTables.add(table);
        let caught: unknown = null;
        try {
          await calls[name]();
        } catch (e) {
          caught = e;
        }
        assert.ok(isRiderSchemaPending(caught), `${name} without ${table}: ${String(caught)}`);
      }
    }
    reset();
    mode.failReads.add("rider_earnings");
    await assert.rejects(x.getEarningsSummary(D2), (e: unknown) => !isRiderSchemaPending(e), "any other failure is a plain error (500)");
  });
}

// ---------------------------------------------------------------------------
// 3. the route contract (needs `npm run dev`)
// ---------------------------------------------------------------------------
const ROUTES = [
  "/api/rider/earnings/summary",
  "/api/rider/earnings/records",
  "/api/rider/earnings/payouts",
  "/api/rider/earnings/incentives",
  "/api/rider/earnings/statement?from=2025-11-01&to=2025-11-30",
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
    skip("rider checks (400 invalid_date / invalid_range / invalid_cursor, 200 shapes or 503 migration_pending): QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const expect400 = async (path: string, error: string) => {
    const res = await get(path, cookie);
    check(`${path} -> 400 ${error}`, res.status === 400 && res.json?.error === error, res);
  };
  await expect400("/api/rider/earnings/statement", "invalid_date");
  await expect400("/api/rider/earnings/statement?from=2025-02-30&to=2025-03-01", "invalid_date");
  await expect400("/api/rider/earnings/statement?from=2025-03-02&to=2025-03-01", "invalid_range");
  await expect400("/api/rider/earnings/statement?from=2025-01-01&to=2026-01-02", "invalid_range");
  await expect400("/api/rider/earnings/records?from=2025-1-01&to=2025-01-02", "invalid_date");
  await expect400("/api/rider/earnings/records?from=2025-01-01", "invalid_range");
  await expect400("/api/rider/earnings/records?cursor=zzz", "invalid_cursor");
  for (const route of ROUTES) {
    const res = await get(route, cookie);
    if (res.status === 503) {
      check(`GET ${route} before 0083 -> 503 migration_pending`, res.json?.error === "migration_pending", res);
    } else if (res.status === 403 && res.json?.error === "feature_disabled") {
      skip(`GET ${route}: driver.earnings is switched off for the QA rider`);
    } else {
      check(`GET ${route} -> 200`, res.status === 200, res);
    }
  }
}

async function main(): Promise<void> {
  console.log("-- 1. pure maths");
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
