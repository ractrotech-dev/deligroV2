/**
 * QA — rider cash (Phase 5 Tasks 2 and 3): the pure maths, the data layer
 * against a fake PostgREST, the route doors, and the route contract.
 *
 *   npm run test:rider-cash   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_RIDER_EMAIL / QA_RIDER_PASSWORD          a driver account
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-driver account
 *
 * Four tiers:
 *
 *   1. Pure (`lib/rider/cash-math.ts`): the summary (Review Focus 3 and 4, the
 *      day statuses across three days with a late deposit, the IST day cut, the
 *      over-limit and over-hours rules), deposit validation (Review Focus 2),
 *      the duplicate-warning helper `sameDayHandoverTotal` (Review Focus 1), the
 *      reminder rule and the settings parser (Task 3). Always run.
 *   2. The data layer (`data-access/rider-cash.ts`) against an in-memory
 *      PostgREST + storage: every figure, the deposit workflow (declare, confirm
 *      writing the one `cod_handovers` row, dispute, withdraw, two managers
 *      confirming at once), disputes, reminders and a database without 0085
 *      (RiderSchemaPendingError -> 503 migration_pending). Always run.
 *   3. The route doors, read from source: every /api/rider/cash route opens with
 *      `riderCashGate` (role check + rate limit) before it reads a body, and the
 *      manager actions check the role first. Always run.
 *   4. Route contract against the dev server: 401 with no cookie, 403 for a
 *      customer, 400s for malformed input, 200 shapes or 503 migration_pending.
 *      Session-dependent checks SKIP without QA accounts, and everything SKIPs
 *      when the server is not running (ruling R2: no database has 0085). Nothing
 *      in it writes: every POST sent is refused before the database is reached.
 *
 * Never sends push/SMS/OTP and never writes live data: every ONESIGNAL variable
 * is removed before any module loads and the fake is the only thing written to.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
// fixtures
// ---------------------------------------------------------------------------
const R1 = "00000000-0000-4000-8000-0000000000d1";
const R2 = "00000000-0000-4000-8000-0000000000d2";
const R3 = "00000000-0000-4000-8000-0000000000d3";
const R4 = "00000000-0000-4000-8000-0000000000d4";
const MGR = "00000000-0000-4000-8000-0000000000e1";
const MGR2 = "00000000-0000-4000-8000-0000000000e2";
const CUST = "00000000-0000-4000-8000-0000000000c1";
const order = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
const delivery = (n: number) => `b${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
/** An IST wall-clock instant as ISO (UTC). */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const m = await import("../../src/lib/rider/cash-math");

  const NOW = new Date(ist("2026-10-21", "20:00"));
  const base = { toCollect: 0, collections: [], handovers: [], deposits: [], disputes: [], limit: 5000, maxHours: 24 };
  const col = (day: string, hhmm: string, amount: number) => ({ amount, at: ist(day, hhmm) });
  const day = (s: ReturnType<typeof m.buildCashSummary>, d: string) => s.days.find((x) => x.day === d);

  await group("a rider with no COD orders ever: zeros, no days, nothing over (Review Focus 5, server side)", () => {
    const s = m.buildCashSummary(base, NOW);
    assert.deepEqual(s, {
      toCollect: 0, collectedToday: 0, depositedToday: 0, collectedTotal: 0, depositedTotal: 0, pending: 0,
      submittedAwaiting: 0, oldestUndepositedAt: null, overLimit: false, overHours: false, limit: 5000, maxHours: 24, days: [],
    });
  });

  await group("the summary: collected − confirmed handovers; today by IST day; submitted is shown, not subtracted", () => {
    const s = m.buildCashSummary(
      {
        ...base,
        toCollect: 450,
        collections: [col("2026-10-20", "11:00", 700), col("2026-10-21", "10:00", 300), col("2026-10-21", "12:00", 200)],
        handovers: [{ amount: 400, day: "2026-10-21" }],
        deposits: [
          { status: "submitted", amount: 250, createdAt: ist("2026-10-21", "14:00"), decisionNote: null },
          { status: "withdrawn", amount: 999, createdAt: ist("2026-10-21", "14:00"), decisionNote: null },
          { status: "confirmed", amount: 400, createdAt: ist("2026-10-21", "13:00"), decisionNote: null },
        ],
      },
      NOW
    );
    assert.equal(s.toCollect, 450);
    assert.equal(s.collectedToday, 500);
    assert.equal(s.depositedToday, 400);
    assert.equal(s.collectedTotal, 1200);
    assert.equal(s.depositedTotal, 400, "a confirmed deposit is counted once, through its handover — not again from cash_deposits");
    assert.equal(s.pending, 800);
    assert.equal(s.submittedAwaiting, 250, "only the submitted one");
    assert.equal(s.pending - s.submittedAwaiting, m.availableToDeclare(s));
  });

  await group("pending never goes below zero (0154 reads the same): a manager recorded more than was collected", () => {
    const s = m.buildCashSummary({ ...base, collections: [col("2026-10-21", "10:00", 100)], handovers: [{ amount: 250, day: "2026-10-21" }] }, NOW);
    assert.equal(s.pending, 0);
    assert.equal(s.depositedTotal, 250);
    assert.equal(s.oldestUndepositedAt, null);
    assert.equal(m.availableToDeclare(s), 0);
  });

  await group("the IST day cut: 00:15 IST belongs to the new day, 23:45 IST to the old", () => {
    const s = m.buildCashSummary(
      { ...base, collections: [{ amount: 100, at: "2026-10-20T18:45:00Z" }, { amount: 40, at: "2026-10-20T18:15:00Z" }] },
      NOW
    );
    assert.equal(day(s, "2026-10-21")?.collected, 100, "18:45Z = 00:15 IST on the 21st");
    assert.equal(day(s, "2026-10-20")?.collected, 40, "18:15Z = 23:45 IST on the 20th");
    assert.equal(s.collectedToday, 100);
  });

  await group("day statuses across three days with a LATE deposit (deposits settle the oldest cash first)", () => {
    const collections = [col("2026-10-19", "11:00", 1000), col("2026-10-20", "11:00", 500), col("2026-10-21", "11:00", 300)];
    // Day 1 and 2 pass with nothing deposited; on day 3 the rider hands over 1000, which pays for day 1 only.
    const late = m.buildCashSummary({ ...base, collections, handovers: [{ amount: 1000, day: "2026-10-21" }] }, NOW);
    assert.deepEqual(late.days.map((d) => [d.day, d.status]), [["2026-10-21", "pending"], ["2026-10-20", "pending"], ["2026-10-19", "settled"]]);
    assert.equal(late.pending, 800);
    assert.equal(late.oldestUndepositedAt, ist("2026-10-20", "11:00"), "the 20th's cash is the oldest still in hand");
    assert.equal(day(late, "2026-10-21")?.deposited, 1000, "the deposit is shown on the day it was made");
    // Everything deposited: all three settled.
    const all = m.buildCashSummary({ ...base, collections, handovers: [{ amount: 1000, day: "2026-10-21" }, { amount: 800, day: "2026-10-21" }] }, NOW);
    assert.ok(all.days.every((d) => d.status === "settled"));
    assert.equal(all.pending, 0);
    assert.equal(all.oldestUndepositedAt, null);
    // A deposit before any cash (day 1 settled on day 1).
    const prompt = m.buildCashSummary({ ...base, collections: [col("2026-10-20", "11:00", 500)], handovers: [{ amount: 500, day: "2026-10-20" }] }, NOW);
    assert.equal(day(prompt, "2026-10-20")?.status, "settled");
  });

  await group("a DISPUTED deposit: stays out of 'deposited', the day reads disputed, the rider sees the manager's note (Review Focus 4)", () => {
    const s = m.buildCashSummary(
      {
        ...base,
        collections: [col("2026-10-20", "11:00", 500)],
        deposits: [{ status: "disputed", amount: 500, createdAt: ist("2026-10-20", "19:00"), decisionNote: "Only 400 reached me" }],
      },
      NOW
    );
    assert.equal(s.depositedTotal, 0, "not deposited");
    assert.equal(s.pending, 500);
    assert.equal(s.submittedAwaiting, 0);
    const d = day(s, "2026-10-20");
    assert.equal(d?.status, "disputed");
    assert.equal(d?.note, "Only 400 reached me");
    // Once the cash is later covered by confirmed deposits the day is settled again.
    const covered = m.buildCashSummary(
      {
        ...base,
        collections: [col("2026-10-20", "11:00", 500)],
        handovers: [{ amount: 500, day: "2026-10-21" }],
        deposits: [{ status: "disputed", amount: 500, createdAt: ist("2026-10-20", "19:00"), decisionNote: "Only 400 reached me" }],
      },
      NOW
    );
    assert.equal(day(covered, "2026-10-20")?.status, "settled");
    assert.equal(day(covered, "2026-10-20")?.note, null, "a day that is not disputed carries no note");
    assert.equal(day(m.buildCashSummary({ ...base, collections: [col("2026-10-20", "11:00", 500)] }, NOW), "2026-10-20")?.note, null, "nor does a plain pending day");
  });

  await group("an OPEN cash dispute marks its day disputed even when settled; a resolved one does not", () => {
    const withOpen = m.buildCashSummary(
      { ...base, collections: [col("2026-10-20", "11:00", 500)], handovers: [{ amount: 500, day: "2026-10-20" }], disputes: [{ day: "2026-10-20", status: "open" }] },
      NOW
    );
    assert.equal(day(withOpen, "2026-10-20")?.status, "disputed");
    const resolved = m.buildCashSummary(
      { ...base, collections: [col("2026-10-20", "11:00", 500)], handovers: [{ amount: 500, day: "2026-10-20" }], disputes: [{ day: "2026-10-20", status: "resolved" }] },
      NOW
    );
    assert.equal(day(resolved, "2026-10-20")?.status, "settled");
    // A dispute on a day with no activity still lists the day.
    const quiet = m.buildCashSummary({ ...base, disputes: [{ day: "2026-10-18", status: "open" }] }, NOW);
    assert.deepEqual(quiet.days.map((d) => [d.day, d.status, d.collected]), [["2026-10-18", "disputed", 0]]);
  });

  await group("the day list reaches back 30 days", () => {
    const s = m.buildCashSummary({ ...base, collections: [col("2026-09-21", "10:00", 10), col("2026-09-22", "10:00", 10)] }, NOW);
    assert.deepEqual(s.days.map((d) => d.day), ["2026-09-22"], "Sept 22 is 29 days before Oct 21; Sept 21 is out");
    assert.equal(s.collectedTotal, 20, "older cash still counts in the totals");
  });

  await group("over limit and over hours: strictly above the limit; from the oldest cash still in hand; 0 switches a rule off", () => {
    const at = (h: number) => hoursAgo(NOW, h);
    const mk = (amount: number, ageH: number, over: Partial<typeof base> = {}) =>
      m.buildCashSummary({ ...base, ...over, collections: [{ amount, at: at(ageH) }] }, NOW);
    assert.equal(mk(5001, 1).overLimit, true);
    assert.equal(mk(5000, 1).overLimit, false, "at the limit is not over it");
    assert.equal(mk(9000, 1, { limit: 0 }).overLimit, false, "limit 0 = off");
    assert.equal(mk(100, 24).overHours, true, "held exactly the maximum");
    assert.equal(mk(100, 23.9).overHours, false);
    assert.equal(mk(100, 500, { maxHours: 0 }).overHours, false, "hours 0 = off");
    // Old cash already deposited does not make the rider late: the oldest cash IN HAND is what counts.
    const fifo = m.buildCashSummary(
      { ...base, collections: [{ amount: 100, at: at(40) }, { amount: 100, at: at(2) }], handovers: [{ amount: 100, day: "2026-10-21" }] },
      NOW
    );
    assert.equal(fifo.oldestUndepositedAt, at(2));
    assert.equal(fifo.overHours, false);
    // Nothing pending: never over, whatever the history.
    const clear = m.buildCashSummary({ ...base, collections: [{ amount: 9000, at: at(90) }], handovers: [{ amount: 9000, day: "2026-10-21" }] }, NOW);
    assert.deepEqual([clear.overLimit, clear.overHours, clear.oldestUndepositedAt], [false, false, null]);
    assert.deepEqual([mk(1, 1).limit, mk(1, 1).maxHours], [5000, 24], "the thresholds ride along for the app's explanation");
  });

  await group("deposit validation: whole rupees above zero, a UPI reference, never more than the rider can still declare (Review Focus 2)", () => {
    const pos = { pending: 1200, submittedAwaiting: 200 };
    assert.deepEqual(m.checkDeposit({ amount: 1000, method: "cash" }, pos), { ok: true, amount: 1000, method: "cash", reference: null });
    const over = m.checkDeposit({ amount: 1001, method: "cash" }, pos);
    assert.deepEqual(over, { ok: false, error: "exceeds_pending", pending: 1200, available: 1000 });
    assert.equal(m.checkDeposit({ amount: 1200, method: "cash" }, { pending: 1200, submittedAwaiting: 0 }).ok, true, "all of it is fine");
    for (const bad of [0, -5, 1.5, NaN, "500", null, undefined, m.MAX_DEPOSIT + 1]) {
      assert.deepEqual(
        m.checkDeposit({ amount: bad, method: "cash" }, { pending: 9_000_000, submittedAwaiting: 0 }),
        { ok: false, error: "invalid_amount" },
        `amount ${String(bad)}`
      );
    }
    assert.equal(m.checkDeposit({ amount: 5, method: "cheque" }, pos).ok, false);
    assert.deepEqual(m.checkDeposit({ amount: 5, method: "upi" }, pos), { ok: false, error: "reference_required" });
    assert.deepEqual(m.checkDeposit({ amount: 5, method: "upi", reference: "   " }, pos), { ok: false, error: "reference_required" });
    assert.deepEqual(m.checkDeposit({ amount: 5, method: "upi", reference: "x".repeat(65) }, pos), { ok: false, error: "reference_required" });
    assert.deepEqual(m.checkDeposit({ amount: 5, method: "upi", reference: " 4123 " }, pos), { ok: true, amount: 5, method: "upi", reference: "4123" });
    assert.equal((m.checkDeposit({ amount: 5, method: "cash", reference: "junk" }, pos) as { reference: string | null }).reference, null, "a cash deposit drops a stray reference");
  });

  await group("sameDayHandoverTotal: what this rider already handed over that day, and nothing else (Review Focus 1)", () => {
    const rows = [
      { leg: "rider_to_manager", fromUser: R1, amount: 300, handoverDate: "2026-10-21" },
      { leg: "rider_to_manager", fromUser: R1, amount: 120, handoverDate: "2026-10-21" },
      { leg: "rider_to_manager", fromUser: R1, amount: 999, handoverDate: "2026-10-20" },
      { leg: "rider_to_manager", fromUser: R2, amount: 777, handoverDate: "2026-10-21" },
      { leg: "manager_to_owner", fromUser: R1, amount: 555, handoverDate: "2026-10-21" },
      { leg: "rider_to_manager", fromUser: null, amount: 444, handoverDate: "2026-10-21" },
    ];
    assert.equal(m.sameDayHandoverTotal(rows, R1, "2026-10-21"), 420);
    assert.equal(m.sameDayHandoverTotal(rows, R1, "2026-10-22"), 0);
    assert.equal(m.sameDayHandoverTotal(rows, R3, "2026-10-21"), 0);
    assert.equal(m.sameDayHandoverTotal([], R1, "2026-10-21"), 0);
  });

  await group("reminders: the reason, and at most one every 6 hours", () => {
    assert.equal(m.reminderReason({ overLimit: false, overHours: false }), null);
    assert.equal(m.reminderReason({ overLimit: true, overHours: false }), "limit");
    assert.equal(m.reminderReason({ overLimit: false, overHours: true }), "hours");
    assert.equal(m.reminderReason({ overLimit: true, overHours: true }), "both");
    const now = new Date("2026-10-21T12:00:00Z");
    assert.equal(m.reminderDue(null, now), true);
    assert.equal(m.reminderDue(undefined, now), true);
    assert.equal(m.reminderDue("2026-10-21T06:00:01Z", now), false, "5h59m59s ago");
    assert.equal(m.reminderDue("2026-10-21T06:00:00Z", now), true, "exactly 6h ago");
    assert.equal(m.reminderDue("not a date", now), true);
  });

  await group("settings parser (Task 3): whole numbers from 0 to the 0085 maximum; a negative, fractional, junk or too-large value is REFUSED, not clamped", () => {
    const cur = { limit: 5000, maxHours: 24 };
    assert.deepEqual(m.parseCashLimits({ limit: "8000", maxHours: "12" }, cur), { ok: true, limit: 8000, maxHours: 12 });
    assert.deepEqual(m.parseCashLimits({ limit: " 0 ", maxHours: "0" }, cur), { ok: true, limit: 0, maxHours: 0 }, "0 switches a rule off");
    assert.deepEqual(m.parseCashLimits({ limit: "100000", maxHours: "720" }, cur), { ok: true, limit: 100000, maxHours: 720 }, "the maximum is allowed");
    assert.deepEqual(m.parseCashLimits({}, cur), { ok: true, limit: 5000, maxHours: 24 }, "not posted keeps what is stored");
    assert.deepEqual(m.parseCashLimits({ limit: "", maxHours: null }, cur), { ok: true, limit: 5000, maxHours: 24 }, "blank keeps what is stored");
    for (const bad of ["-1", "-5000", "100001", "999999999", "1.5", "1e3", "abc", "0x10", "5 000", "Infinity", "NaN"]) {
      const r = m.parseCashLimits({ limit: bad }, cur);
      assert.equal(r.ok, false, `limit ${bad} must be refused`);
    }
    for (const bad of ["-1", "721", "2.5", "x"]) {
      assert.equal(m.parseCashLimits({ maxHours: bad }, cur).ok, false, `hours ${bad} must be refused`);
    }
    const refused = m.parseCashLimits({ limit: "-1" }, cur);
    assert.ok(!refused.ok && /cash limit/i.test(refused.error) && /1,00,000/.test(refused.error), "the message says what is allowed");
    assert.equal(m.parseCashLimits({ limit: "100001", maxHours: "5" }, cur).ok, false, "one bad field refuses the pair");
  });
}

// ---------------------------------------------------------------------------
// 2. data layer against a fake PostgREST + storage
// ---------------------------------------------------------------------------
const db: Record<string, Row[]> = {};
const storage = new Map<string, number>();
const mode = {
  missingTables: new Set<string>(),
  failInsert: new Set<string>(),
  failReads: new Set<string>(),
  missingFunction: false,
  failUpload: false,
  /** Runs just before a POST is applied: a concurrent request's write landing between the read and the insert. */
  beforeInsert: null as null | ((table: string) => void),
};
const requests: { method: string; table: string; query: string; body: unknown }[] = [];
const t = (name: string): Row[] => (db[name] ??= []);
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  storage.clear();
  mode.missingTables.clear();
  mode.failInsert.clear();
  mode.failReads.clear();
  mode.missingFunction = false;
  mode.failUpload = false;
  mode.beforeInsert = null;
  requests.length = 0;
  t("platform_settings").push({ id: true, rider_cash_limit: 5000, rider_cash_max_hours: 24 });
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or"]);

function compare(a: unknown, b: string): number {
  const n = Number(b);
  if (typeof a === "number" && Number.isFinite(n)) return a - n;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function test(row: Row, col: string, rawOp: string): boolean {
  const value = row[col];
  const negate = rawOp.startsWith("not.");
  const body = negate ? rawOp.slice(4) : rawOp;
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
    default: throw new Error(`fake PostgREST: unsupported filter ${col}=${rawOp}`);
  }
  return negate ? !hit : hit;
}

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (key === "or") {
      // or=(a.is.null,b.lt.2026-...) — split on the commas that start a new "col." term
      const terms = raw.slice(1, -1).split(/,(?=[a-z_]+\.)/);
      const any = terms.some((term) => {
        const dot = term.indexOf(".");
        return test(row, term.slice(0, dot), term.slice(dot + 1));
      });
      if (!any) return false;
      continue;
    }
    if (RESERVED.has(key)) continue;
    if (!test(row, key, raw)) return false;
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

const MAX_ROWS = 1000;
const DEFAULTS: Record<string, () => Row> = {
  cash_deposits: () => ({
    status: "submitted", manager_id: null, reference: null, photo_path: null, note: null, handover_id: null,
    decided_by: null, decided_at: null, decision_note: null, created_at: new Date().toISOString(),
  }),
  cash_disputes: () => ({ status: "open", claimed_amount: null, resolution: null, resolved_by: null, resolved_at: null, created_at: new Date().toISOString() }),
  cod_handovers: () => ({ created_at: new Date().toISOString(), note: null, to_user: null }),
  support_tickets: () => ({ number: ++ticketSeq, status: "open", priority: "normal", resolved_at: null, created_at: new Date().toISOString() }),
  user_notifications: () => ({ data: {}, read_at: null, created_at: new Date().toISOString() }),
};
let ticketSeq = 100;
const UNIQUE: Record<string, string> = { cash_reminders: "driver_id" };

/** The CHECK constraints of 0085 that the fake can enforce on a write. */
function violates(table: string, row: Row): string | null {
  if (table === "cash_deposits") {
    if (row.status === "confirmed" && !row.handover_id) return "cash_deposits_confirmed_handover";
    if (row.status === "disputed" && !row.decision_note) return "cash_deposits_disputed_note";
  }
  return null;
}

function withEmbeds(table: string, rows: Row[], select: string): Row[] {
  if (table === "deliveries" && select.includes("orders(")) {
    return rows.map((r) => ({ ...r, orders: t("orders").find((o) => o.id === r.order_id) ?? null }));
  }
  return rows;
}

const istDayOf = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

/**
 * `ops_decide_cash_deposit` as the route sees it. The SQL itself is proved in
 * scripts/qa/sql/migration-0085.mjs (PGlite); this reproduces its outcomes so the
 * data layer's mapping of them can be tested. One synchronous step = atomic.
 */
function rpcDecide(args: Row): { code: number; body: Row } {
  const err = (code: number, pg: string, message: string) => ({ code, body: { code: pg, message } });
  const dep = t("cash_deposits").find((d) => d.id === args.p_deposit);
  if (!dep) return err(403, "42501", "forbidden");
  const actor = t("profiles").find((pr) => pr.id === args.p_actor);
  if (!actor || !["manager", "admin"].includes(actor.role)) return err(403, "42501", "forbidden");
  if (dep.status !== "submitted") return err(400, "22023", "already_decided");
  const note = typeof args.p_note === "string" ? args.p_note.trim() : "";
  if (args.p_decision === "dispute" && (note.length < 3 || note.length > 500)) return err(400, "22023", "note_required");
  if (args.p_decision !== "confirm" && args.p_decision !== "dispute") return err(400, "22023", "invalid_transition");
  if (args.p_decision === "dispute") {
    Object.assign(dep, { status: "disputed", decided_by: actor.id, decided_at: new Date().toISOString(), decision_note: note });
    return { code: 200, body: { deposit_id: dep.id, status: "disputed", handover_id: null, replayed: false } };
  }
  const day = istDayOf(dep.created_at);
  const linked = new Set(t("cash_deposits").map((d) => d.handover_id).filter(Boolean));
  if (t("cod_handovers").some((h) => h.leg === "rider_to_manager" && h.from_user === dep.driver_id && h.handover_date === day && !linked.has(h.id))) {
    return err(409, "23505", "manual_handover_exists");
  }
  if (mode.failInsert.has("cod_handovers")) return err(500, "XX000", "boom"); // rolled back whole: nothing written
  const h = {
    id: crypto.randomUUID(), leg: "rider_to_manager", from_user: dep.driver_id, to_user: dep.manager_id ?? actor.id,
    amount: dep.amount, handover_date: day, recorded_by: actor.id, created_at: new Date().toISOString(),
    note: note || `Deposit ${dep.method}${dep.reference ? ` ${dep.reference}` : ""}`,
  };
  t("cod_handovers").push(h);
  Object.assign(dep, { status: "confirmed", handover_id: h.id, decided_by: actor.id, decided_at: new Date().toISOString(), decision_note: note || null });
  return { code: 200, body: { deposit_id: dep.id, status: "confirmed", handover_id: h.id, replayed: false } };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };

    // storage
    if (url.pathname.startsWith("/storage/v1/")) {
      const rest = url.pathname.replace("/storage/v1/", "");
      if (req.method === "POST" && rest.startsWith("object/sign/")) {
        return send(200, { signedURL: `/${rest}?token=fake` });
      }
      if (req.method === "POST" && rest.startsWith("object/")) {
        if (mode.failUpload) return send(400, { message: "upload failed" });
        storage.set(decodeURIComponent(rest.replace("object/", "")), rawBody.length);
        return send(200, { Key: rest.replace("object/", "") });
      }
      if (req.method === "DELETE" && rest.startsWith("object/")) {
        const bucket = rest.replace("object/", "");
        const prefixes: string[] = JSON.parse(rawBody.toString() || "{}").prefixes ?? [];
        for (const p of prefixes) storage.delete(`${bucket}/${p}`);
        return send(200, []);
      }
      return send(404, { message: "not found" });
    }

    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | Row[] | null = rawBody.length ? JSON.parse(rawBody.toString()) : null;
    requests.push({ method: req.method ?? "", table, query: decodeURIComponent(url.search), body });
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };
    if (table === "rpc/obs_ingest") return send(200, null);
    if (table === "rpc/ops_decide_cash_deposit") {
      if (mode.missingFunction) return send(404, { code: "PGRST202", message: "Could not find the function public.ops_decide_cash_deposit in the schema cache" });
      const out = rpcDecide((body ?? {}) as Row);
      return send(out.code, out.body);
    }
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
      return respond(withEmbeds(table, rows, url.searchParams.get("select") ?? ""));
    }
    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      const hit = t(table).filter((r) => matches(r, url));
      for (const row of hit) {
        const bad = violates(table, { ...row, ...body });
        if (bad) return send(400, { code: "23514", message: `new row violates check constraint "${bad}"` });
      }
      for (const row of hit) Object.assign(row, body);
      return send(200, hit);
    }
    if (req.method === "POST" && body) {
      if (mode.failInsert.has(table)) return send(500, { code: "XX000", message: "boom" });
      const incoming = (Array.isArray(body) ? body : [body]).map((r) => ({
        id: crypto.randomUUID(),
        ...(DEFAULTS[table]?.() ?? {}),
        ...r,
      }));
      mode.beforeInsert?.(table);
      if (table === "cash_disputes") {
        // 0085's cash_disputes_one_open_per_day (partial unique index)
        for (const r of incoming) {
          if ((r.status ?? "open") === "open" && t("cash_disputes").some((d) => d.driver_id === r.driver_id && d.day === r.day && d.status === "open")) {
            return send(409, { code: "23505", message: 'duplicate key value violates unique constraint "cash_disputes_one_open_per_day"' });
          }
        }
      }
      if (table === "cod_handovers") {
        // 0085's guard_manual_rider_handover: a hand-written rider_to_manager leg on a day with a submitted or confirmed deposit
        for (const r of incoming) {
          if (r.leg === "rider_to_manager" && r.from_user && t("cash_deposits").some((d) =>
            d.driver_id === r.from_user && ["submitted", "confirmed"].includes(d.status) && istDayOf(d.created_at) === r.handover_date)) {
            return send(409, { code: "23505", message: "deposit_exists" });
          }
        }
      }
      const key = UNIQUE[table];
      if (key && incoming.some((r) => t(table).some((x) => x[key] === r[key]))) {
        return send(409, { code: "23505", message: `duplicate key value violates unique constraint "${table}_pkey"` });
      }
      for (const r of incoming) {
        const bad = violates(table, r);
        if (bad) return send(400, { code: "23514", message: `new row violates check constraint "${bad}"` });
      }
      t(table).push(...incoming);
      return respond(incoming, 201);
    }
    if (req.method === "DELETE") {
      const gone = t(table).filter((r) => matches(r, url));
      db[table] = t(table).filter((r) => !matches(r, url));
      return send(200, gone);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

/** Fixtures in the shape of the real tables. */
function seedProfiles(): void {
  t("profiles").push(
    { id: R1, role: "driver", full_name: "Ravi Kumar" },
    { id: R2, role: "driver", full_name: "Sunita Devi" },
    { id: R3, role: "driver", full_name: "Third Rider" },
    { id: R4, role: "driver", full_name: "Fourth Rider" },
    { id: MGR, role: "manager", full_name: "Anil Manager" },
    { id: MGR2, role: "manager", full_name: "Meena Manager" },
    { id: CUST, role: "customer", full_name: "A Customer" }
  );
  t("rider_profiles").push({ driver_id: R1, rider_code: "DR-0001" }, { driver_id: R2, rider_code: "DR-0002" });
}

/** An order and its delivery. */
function seedDelivery(n: number, driver: string, o: {
  status?: string; total?: number; method?: "cod" | "online"; payment?: string;
  collected?: number | null; collectedAt?: string | null; deliveredAt?: string | null;
}): void {
  t("orders").push({ id: order(n), total: o.total ?? 0, payment_method: o.method ?? "cod", payment_status: o.payment ?? "pending" });
  t("deliveries").push({
    id: delivery(n), order_id: order(n), driver_id: driver, status: o.status ?? "delivered",
    delivered_at: o.deliveredAt ?? o.collectedAt ?? null,
    cod_collected_amount: o.collected ?? null, cod_collected_at: o.collectedAt ?? null,
  });
}

const seedHandover = (driver: string, amount: number, day: string, extra: Row = {}) =>
  t("cod_handovers").push({
    id: crypto.randomUUID(), leg: "rider_to_manager", from_user: driver, to_user: MGR, amount,
    handover_date: day, recorded_by: MGR, created_at: new Date().toISOString(), ...extra,
  });

const seedDeposit = (driver: string, o: Row = {}): Row => {
  const row: Row = {
    id: crypto.randomUUID(), driver_id: driver, amount: 100, method: "cash", manager_id: null, reference: null,
    photo_path: null, note: null, status: "submitted", handover_id: null, decided_by: null, decided_at: null,
    decision_note: null, created_at: new Date().toISOString(), ...o,
  };
  t("cash_deposits").push(row);
  return row;
};

const JPEG = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1])], "r.jpg", { type: "image/jpeg" });

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const x = await import("../../src/lib/data-access/rider-cash");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");
  const { istDateKey } = await import("../../src/lib/utils/ist-time");
  const today = istDateKey();

  const SUMMARY_NOW = new Date("2026-10-22T10:00:00Z"); // 15:30 IST on the 22nd

  await group("data: the position — COD collected, handed over, awaiting, to collect; online-paid never counts as cash (Review Focus 3); another rider's rows never count", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 400, collected: 400, collectedAt: ist("2026-10-21", "11:00") });
    seedDelivery(2, R1, { total: 350, collected: 350, collectedAt: ist("2026-10-22", "09:00") });
    seedDelivery(3, R1, { total: 250, collected: 250, collectedAt: ist("2026-10-22", "13:00") });
    // paid online and delivered: nothing collected, never cash
    seedDelivery(4, R1, { total: 999, method: "online", payment: "paid", collected: null, deliveredAt: ist("2026-10-22", "10:00") });
    // in hand: one cash order to collect, one online order that is not cash
    seedDelivery(5, R1, { status: "picked_up", total: 450 });
    seedDelivery(6, R1, { status: "assigned", total: 300, method: "online", payment: "paid" });
    // another rider's cash and handover
    seedDelivery(7, R2, { total: 5000, collected: 5000, collectedAt: ist("2026-10-22", "09:00") });
    seedHandover(R2, 5000, "2026-10-22");
    seedHandover(R1, 600, "2026-10-22");
    seedHandover(R1, 77, "2026-10-22", { leg: "manager_to_owner" });
    seedDeposit(R1, { amount: 200, status: "submitted" });
    seedDeposit(R1, { amount: 100, status: "disputed", decision_note: "Short", created_at: ist("2026-10-21", "18:00") });
    seedDeposit(R1, { amount: 50, status: "withdrawn" });
    seedDeposit(R2, { amount: 9999, status: "submitted" });
    t("cash_disputes").push({ id: "d1", driver_id: R1, day: "2026-10-21", status: "open", claimed_amount: null, message: "m" });
    t("cash_disputes").push({ id: "d2", driver_id: R2, day: "2026-10-22", status: "open", claimed_amount: null, message: "m" });

    const s = await x.getRiderCashSummary(R1, SUMMARY_NOW);
    assert.equal(s.toCollect, 450, "only the cash order in hand: the online one is not cash to collect");
    assert.equal(s.collectedTotal, 1000, "400 + 350 + 250: the online-paid order is not collected cash");
    assert.equal(s.collectedToday, 600);
    assert.equal(s.depositedTotal, 600, "this rider's rider_to_manager handovers only");
    assert.equal(s.depositedToday, 600);
    assert.equal(s.pending, 400);
    assert.equal(s.submittedAwaiting, 200, "the submitted deposit; not the disputed, withdrawn or another rider's");
    assert.equal(s.oldestUndepositedAt, ist("2026-10-22", "09:00"), "the 21st's 400 is covered first; the 22nd's 09:00 cash is the oldest in hand");
    assert.equal(s.overLimit, false);
    assert.equal(s.overHours, false);
    const byDay = Object.fromEntries(s.days.map((d) => [d.day, d]));
    assert.equal(byDay["2026-10-21"].status, "disputed", "an open dispute and a disputed deposit that day");
    assert.equal(byDay["2026-10-21"].note, "Short");
    assert.equal(byDay["2026-10-22"].status, "pending");
    // every read is the rider's own
    const reads = requests.filter((r) => ["deliveries", "cash_deposits", "cash_disputes"].includes(r.table));
    assert.ok(reads.length >= 4 && reads.every((r) => r.query.includes(`driver_id=eq.${R1}`)), "deliveries, deposits and disputes are filtered to the rider");
    assert.ok(requests.filter((r) => r.table === "cod_handovers").every((r) => r.query.includes(`from_user=eq.${R1}`)), "handovers are filtered to the rider");
  });

  await group("data: a rider with no COD orders ever reads zeros, not an error (Review Focus 5)", async () => {
    reset();
    seedProfiles();
    const s = await x.getRiderCashSummary(R3, SUMMARY_NOW);
    assert.deepEqual(
      [s.toCollect, s.collectedTotal, s.depositedTotal, s.pending, s.submittedAwaiting, s.oldestUndepositedAt, s.days.length],
      [0, 0, 0, 0, 0, null, 0]
    );
    const c = await x.listRiderCollections(R3, {}, SUMMARY_NOW);
    assert.deepEqual(c, { items: [], nextCursor: null });
    assert.deepEqual(await x.listRiderDeposits(R3), []);
  });

  await group("data: collections list cash and 'paid online' apart, newest first, paged, in an IST range", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 400, collected: 400, collectedAt: ist("2026-10-20", "11:00") });
    seedDelivery(2, R1, { total: 600, method: "online", payment: "paid", collected: null, deliveredAt: ist("2026-10-21", "12:00") });
    seedDelivery(3, R1, { total: 250, collected: 250, collectedAt: ist("2026-10-22", "13:00") });
    seedDelivery(4, R1, { total: 180, collected: null, deliveredAt: ist("2026-10-22", "09:00") }); // cash order whose collection was never recorded
    seedDelivery(5, R1, { status: "cancelled", total: 99 });
    seedDelivery(6, R2, { total: 777, collected: 777, collectedAt: ist("2026-10-22", "10:00") });
    const all = await x.listRiderCollections(R1, { from: "2026-10-20", to: "2026-10-22" }, SUMMARY_NOW);
    assert.deepEqual(
      all.items.map((i) => [i.code, i.method, i.status, i.amount]),
      [
        [`#${order(3).slice(0, 8).toUpperCase()}`, "cod", "collected", 250],
        [`#${order(4).slice(0, 8).toUpperCase()}`, "cod", "not_recorded", 180],
        [`#${order(2).slice(0, 8).toUpperCase()}`, "online", "paid_online", 600],
        [`#${order(1).slice(0, 8).toUpperCase()}`, "cod", "collected", 400],
      ]
    );
    assert.equal(all.nextCursor, null);
    const first = await x.listRiderCollections(R1, { from: "2026-10-20", to: "2026-10-22", limit: 3 }, SUMMARY_NOW);
    assert.equal(first.items.length, 3);
    assert.ok(first.nextCursor);
    const second = await x.listRiderCollections(R1, { from: "2026-10-20", to: "2026-10-22", limit: 3, cursor: first.nextCursor }, SUMMARY_NOW);
    assert.deepEqual([...first.items, ...second.items].map((i) => i.orderId), all.items.map((i) => i.orderId));
    assert.equal(second.nextCursor, null);
    const dayOnly = await x.listRiderCollections(R1, { from: "2026-10-21", to: "2026-10-21" }, SUMMARY_NOW);
    assert.deepEqual(dayOnly.items.map((i) => i.method), ["online"]);
    // default range = the last 31 IST days
    const dflt = await x.listRiderCollections(R1, {}, SUMMARY_NOW);
    assert.equal(dflt.items.length, 4);
    for (const bad of [{ from: "2026-10-01" }, { to: "2026-10-01" }, { from: "2026-10-05", to: "2026-10-01" }, { from: "2026-02-30", to: "2026-03-01" }, { from: "x", to: "y" }]) {
      await assert.rejects(x.listRiderCollections(R1, bad, SUMMARY_NOW), (e: Error) => e.name === "CashInputError" && ["invalid_range", "invalid_date"].includes((e as unknown as { code: string }).code), JSON.stringify(bad));
    }
    await assert.rejects(x.listRiderCollections(R1, { cursor: "zzz!" }, SUMMARY_NOW), (e: Error) => (e as unknown as { code: string }).code === "invalid_cursor");
  });

  await group("data: declaring a deposit — exceeds_pending shows the held cash (Review Focus 2); the declaration awaits a manager and joins 'awaiting'", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    const over = await x.submitDeposit(R1, { amount: 1001, method: "cash" });
    assert.deepEqual(over, { ok: false, error: "exceeds_pending", pending: 1000, available: 1000 });
    assert.equal(t("cash_deposits").length, 0, "nothing written");
    const ok = await x.submitDeposit(R1, { amount: 600, method: "cash", managerId: MGR, note: "end of shift" });
    assert.equal(ok.ok, true);
    const row = t("cash_deposits")[0];
    assert.deepEqual(
      [row.driver_id, row.amount, row.method, row.manager_id, row.status, row.handover_id, row.reference, row.note],
      [R1, 600, "cash", MGR, "submitted", null, null, "end of shift"]
    );
    assert.equal(t("cod_handovers").length, 0, "no handover until a manager confirms");
    const s = await x.getRiderCashSummary(R1);
    assert.deepEqual([s.pending, s.submittedAwaiting, s.depositedTotal], [1000, 600, 0]);
    // what is left to declare is 400, so 401 is refused with the held amount
    assert.deepEqual(await x.submitDeposit(R1, { amount: 401, method: "cash" }), { ok: false, error: "exceeds_pending", pending: 1000, available: 400 });
    assert.equal((await x.submitDeposit(R1, { amount: 400, method: "cash" })).ok, true);
    // another rider holding nothing cannot declare anything
    assert.deepEqual(await x.submitDeposit(R3, { amount: 1, method: "cash" }), { ok: false, error: "exceeds_pending", pending: 0, available: 0 });
  });

  await group("A-minor 2: two deposits declared at once cannot together exceed the cash held - the later one is taken back", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    // the other request (700) lands after this one (600) checked 1000 available, before it inserted
    let other: Row | null = null;
    mode.beforeInsert = (table) => {
      if (table !== "cash_deposits") return;
      mode.beforeInsert = null;
      other = seedDeposit(R1, { amount: 700 });
    };
    const r = await x.submitDeposit(R1, { amount: 600, method: "cash" });
    assert.deepEqual(r, { ok: false, error: "exceeds_pending", pending: 1000, available: 300 });
    assert.deepEqual(t("cash_deposits").map((d) => [d.amount, d.status]), [[700, "submitted"]], "only the other declaration stands");
    assert.ok(other);
    const s = await x.getRiderCashSummary(R1);
    assert.equal(s.submittedAwaiting, 700, "never more awaiting than held");
    // without a race the same declaration goes through
    assert.equal((await x.submitDeposit(R1, { amount: 300, method: "cash" })).ok, true);
  });
  await group("A-minor 2: a declaration that raced but still fits is kept", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    mode.beforeInsert = (table) => {
      if (table !== "cash_deposits") return;
      mode.beforeInsert = null;
      seedDeposit(R1, { amount: 300 });
    };
    assert.equal((await x.submitDeposit(R1, { amount: 600, method: "cash" })).ok, true);
    assert.equal(t("cash_deposits").length, 2);
  });

  await group("data: a UPI deposit needs its reference; amounts are whole rupees above zero; the manager must be a manager", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "upi" }), { ok: false, error: "reference_required" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "upi", reference: "  " }), { ok: false, error: "reference_required" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 0, method: "cash" }), { ok: false, error: "invalid_amount" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 10.5, method: "cash" }), { ok: false, error: "invalid_amount" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "cash", managerId: CUST }), { ok: false, error: "invalid_manager" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "cash", managerId: "not-a-uuid" }), { ok: false, error: "invalid_manager" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "cash", note: "n".repeat(301) }), { ok: false, error: "invalid_note" });
    assert.equal(t("cash_deposits").length, 0);
    const ok = await x.submitDeposit(R1, { amount: 100, method: "upi", reference: " 412345678901 " });
    assert.equal(ok.ok, true);
    assert.equal(t("cash_deposits")[0].reference, "412345678901");
  });

  await group("data: the receipt photo — checked by its bytes, stored privately under deposits/<rider>/, removed if the row fails", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    const fake = new File([new TextEncoder().encode("<html>not an image</html>")], "x.jpg", { type: "image/jpeg" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "cash", photo: fake }), { ok: false, error: "bad_photo" });
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])], "x.gif", { type: "image/gif" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "cash", photo: gif }), { ok: false, error: "bad_photo" });
    const empty = new File([], "e.jpg", { type: "image/jpeg" });
    assert.deepEqual(await x.submitDeposit(R1, { amount: 100, method: "cash", photo: empty }), { ok: false, error: "bad_photo" });
    assert.equal(storage.size, 0, "a refused photo stores nothing");
    const ok = await x.submitDeposit(R1, { amount: 100, method: "cash", photo: JPEG() });
    assert.equal(ok.ok, true);
    const path = t("cash_deposits")[0].photo_path as string;
    assert.match(path, new RegExp(`^deposits/${R1}/[0-9a-f-]{36}\\.jpg$`));
    assert.ok(storage.has(`delivery-proofs/${path}`), "in the private delivery-proofs bucket");
    // the row insert failing takes the uploaded file back out
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    mode.failInsert.add("cash_deposits");
    await assert.rejects(x.submitDeposit(R1, { amount: 100, method: "cash", photo: JPEG() }));
    assert.equal(storage.size, 0, "no orphaned receipt");
  });

  await group("data: confirming (ops_decide_cash_deposit) writes the ONE cod_handovers row — from the rider, to the named manager, recorded by the confirmer, dated to the deposit's day — links it, and the position moves", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    const submitted = await x.submitDeposit(R1, { amount: 600, method: "upi", reference: "UTR1", managerId: MGR2, note: "paid at the gate" });
    assert.equal(submitted.ok, true);
    const id = (submitted as { id: string }).id;
    const result = await x.decideDeposit({ id: MGR, role: "manager" }, id, "confirm");
    assert.deepEqual(result, { ok: true });
    const call = requests.find((r) => r.table === "rpc/ops_decide_cash_deposit");
    assert.deepEqual(call?.body, { p_actor: MGR, p_deposit: id, p_decision: "confirm", p_note: null, p_zone: null, p_client_action_id: null }, "the one function, 0152's argument list");
    assert.equal(t("cod_handovers").length, 1);
    const h = t("cod_handovers")[0];
    assert.deepEqual(
      [h.leg, h.from_user, h.to_user, h.amount, h.recorded_by, h.handover_date],
      ["rider_to_manager", R1, MGR2, 600, MGR, today]
    );
    assert.match(h.note, /Deposit upi UTR1/);
    const dep = t("cash_deposits")[0];
    assert.deepEqual([dep.status, dep.handover_id, dep.decided_by], ["confirmed", h.id, MGR]);
    const s = await x.getRiderCashSummary(R1);
    assert.deepEqual([s.depositedTotal, s.pending, s.submittedAwaiting], [600, 400, 0], "deposited through the handover, counted once");
    // the same deposit cannot be decided again
    assert.deepEqual(await x.decideDeposit({ id: MGR2, role: "manager" }, id, "confirm"), { ok: false, error: "already_decided" });
    assert.deepEqual(await x.decideDeposit({ id: MGR2, role: "manager" }, id, "dispute", "late"), { ok: false, error: "already_decided" });
    assert.equal(t("cod_handovers").length, 1, "still exactly one handover");
    // with no named manager the confirmer receives it; the first handover is linked to its deposit, so it is not 'manual'
    const second = (await x.submitDeposit(R1, { amount: 100, method: "cash" })) as { id: string };
    assert.deepEqual(await x.decideDeposit({ id: MGR2, role: "admin" }, second.id, "confirm"), { ok: true });
    assert.equal(t("cod_handovers")[1].to_user, MGR2);
    // unknown and malformed ids
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, crypto.randomUUID(), "confirm"), { ok: false, error: "not_found" });
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, "nope", "confirm"), { ok: false, error: "not_found" });
    // a profile that is not a manager or admin is answered like an unknown deposit
    const third = (await x.submitDeposit(R1, { amount: 50, method: "cash" })) as { id: string };
    assert.deepEqual(await x.decideDeposit({ id: CUST, role: "manager" }, third.id, "confirm"), { ok: false, error: "not_found" });
    assert.equal(t("cod_handovers").length, 2);
  });

  await group("data: two managers confirming (and one disputing) at once: one decision, at most one handover", async () => {
    reset();
    seedProfiles();
    const dep = seedDeposit(R1, { amount: 500 });
    const results = await Promise.all([
      x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "confirm"),
      x.decideDeposit({ id: MGR2, role: "manager" }, dep.id, "confirm"),
      x.decideDeposit({ id: MGR2, role: "manager" }, dep.id, "dispute", "no way"),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    // The function is the only thing that decides, so every loser simply finds the deposit decided.
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "already_decided"), JSON.stringify(results));
    // Whoever won decides: a confirm wrote one handover, a dispute wrote none — never both.
    if (results[2].ok) {
      assert.equal(t("cod_handovers").length, 0, "the dispute won: no handover");
      assert.equal(dep.status, "disputed");
    } else {
      assert.equal(t("cod_handovers").length, 1);
      assert.equal(dep.status, "confirmed");
    }
    // there is no claim: nothing is ever left 'claimed but submitted'
    assert.ok(dep.status !== "submitted" && dep.handover_id !== undefined);
  });

  await group("data: a failed confirmation changes nothing (the function is atomic); the retry then writes exactly one", async () => {
    reset();
    seedProfiles();
    const dep = seedDeposit(R1, { amount: 200 });
    mode.failInsert.add("cod_handovers");
    await assert.rejects(x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "confirm"));
    assert.deepEqual([dep.status, dep.decided_by, dep.handover_id], ["submitted", null, null]);
    assert.equal(t("cod_handovers").length, 0);
    mode.failInsert.delete("cod_handovers");
    assert.equal((await x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "confirm")).ok, true);
    assert.equal(t("cod_handovers").length, 1);
    // the source has no claim path at all
    const src = readFileSync(join(process.cwd(), "src", "lib", "data-access", "rider-cash.ts"), "utf8");
    assert.ok(!/CLAIM_STALE|claim\b.*deposit|recordCodHandover/.test(src.slice(src.indexOf("export async function decideDeposit"), src.indexOf("export interface QueuedDeposit"))), "decideDeposit only calls the function");
  });

  await group("data: a handover already written by hand for the deposit's day — the queue says so, confirming is refused (manual_handover_exists) with the day, nothing is double-counted (Review Focus 1)", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    const dep = (await x.submitDeposit(R1, { amount: 300, method: "cash" })) as { id: string };
    seedHandover(R1, 300, today); // the manager keyed the same handover directly on /manager/cash
    seedHandover(R2, 888, today); // someone else's: not shown for R1
    const queue = await x.listDepositQueue();
    assert.equal(queue.length, 1);
    assert.deepEqual([queue[0].manualHandoverOnDay, queue[0].depositDay], [300, today]);
    assert.deepEqual([queue[0].riderName, queue[0].riderCode, queue[0].amount, queue[0].method], ["Ravi Kumar", "DR-0001", 300, "cash"]);
    const refused = await x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "confirm");
    assert.deepEqual(refused, { ok: false, error: "manual_handover_exists", day: today });
    assert.equal(t("cod_handovers").length, 2, "no third handover was written");
    assert.equal(t("cash_deposits")[0].status, "submitted");
    assert.equal(t("cash_deposits")[0].decided_by, null, "not even touched");
    // there is no 'confirm anyway'
    assert.equal(x.decideDeposit.length, 4);
    // disputing is still open to the manager
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "dispute", "Already recorded by hand"), { ok: true });
  });

  await group("data: a handover a confirmed deposit produced is not 'manual'; a deposit confirmed later is dated to the day it was declared", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    const a = (await x.submitDeposit(R1, { amount: 100, method: "cash" })) as { id: string };
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, a.id, "confirm"), { ok: true });
    const b = (await x.submitDeposit(R1, { amount: 100, method: "cash" })) as { id: string };
    const queue = await x.listDepositQueue();
    assert.equal(queue[0].manualHandoverOnDay, 0, "the first deposit's own handover does not block the second");
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, b.id, "confirm"), { ok: true });
    // a deposit declared two days ago, confirmed today: dated to the day it was declared
    const old = seedDeposit(R2, { amount: 40, created_at: new Date(Date.now() - 50 * 3_600_000).toISOString() });
    assert.equal((await x.decideDeposit({ id: MGR, role: "manager" }, old.id, "confirm")).ok, true);
    const h = t("cod_handovers").find((x2) => x2.id === old.handover_id)!;
    assert.equal(h.handover_date, new Date(Date.parse(old.created_at) + 330 * 60_000).toISOString().slice(0, 10));
    assert.notEqual(h.handover_date, today);
    // ...and a manual handover TODAY does not block it (different day)
    const old2 = seedDeposit(R2, { amount: 40, created_at: new Date(Date.now() - 80 * 3_600_000).toISOString() });
    seedHandover(R2, 40, today);
    assert.equal((await x.decideDeposit({ id: MGR, role: "manager" }, old2.id, "confirm")).ok, true);
  });

  await group("data: confirming more than the rider was recorded as holding warns (it does not refuse — the cash was handed over)", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 100, collected: 100, collectedAt: new Date().toISOString() });
    const big = seedDeposit(R1, { amount: 500 });
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, big.id, "confirm"), { ok: true, warning: { code: "exceeds_pending", pending: 100 } });
    assert.equal(big.status, "confirmed");
    const fine = seedDeposit(R3, { amount: 5 });
    seedDelivery(2, R3, { total: 50, collected: 50, collectedAt: new Date().toISOString() });
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, fine.id, "confirm"), { ok: true }, "within what they hold: no warning");
    // the deposit itself still sits in 'submitted' while pending is read, so a deposit equal to pending is not a warning
    const exact = seedDeposit(R4, { amount: 70 });
    seedDelivery(3, R4, { total: 70, collected: 70, collectedAt: new Date().toISOString() });
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, exact.id, "confirm"), { ok: true });
  });

  await group("data: the decision function missing (0085 not applied) answers migration_pending, never a half result", async () => {
    reset();
    seedProfiles();
    const dep = seedDeposit(R1, { amount: 10 });
    mode.missingFunction = true;
    await assert.rejects(x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "confirm"), (e: unknown) => isRiderSchemaPending(e));
    assert.equal(dep.status, "submitted");
    mode.missingFunction = false;
  });

  await group("data: recordCodHandover by hand — refused with a clear message on a day the rider declared a deposit (0085's guard), still fine otherwise", async () => {
    reset();
    seedProfiles();
    const { recordCodHandover } = await import("../../src/lib/data-access/cod-handovers");
    const free = await recordCodHandover({ leg: "rider_to_manager", fromUserId: R2, toUserId: MGR, amount: 100, recordedBy: MGR });
    assert.deepEqual([free.ok, typeof free.id], [true, "string"]);
    seedDeposit(R1, { amount: 100 });
    const blocked = await recordCodHandover({ leg: "rider_to_manager", fromUserId: R1, toUserId: MGR, amount: 100, recordedBy: MGR });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /declared a deposit/);
    assert.equal(t("cod_handovers").filter((h) => h.from_user === R1).length, 0);
    const toOwner = await recordCodHandover({ leg: "manager_to_owner", fromUserId: MGR, amount: 100, recordedBy: MGR });
    assert.equal(toOwner.ok, true, "other legs are untouched");
  });

  await group("data: the queue — oldest first, receipt as a short-lived signed link inside the rider's own folder only", async () => {
    reset();
    seedProfiles();
    seedDeposit(R2, { id: "newer", amount: 20, created_at: "2026-10-22T09:00:00Z" });
    seedDeposit(R1, { id: "older", amount: 10, created_at: "2026-10-22T08:00:00Z", photo_path: `deposits/${R1}/a.jpg`, reference: "ref", manager_id: MGR });
    seedDeposit(R1, { id: "foreign-path", amount: 11, created_at: "2026-10-22T08:30:00Z", photo_path: `deposits/${R2}/b.jpg` });
    seedDeposit(R1, { id: "decided", amount: 12, status: "disputed", decision_note: "n" });
    const queue = await x.listDepositQueue();
    assert.deepEqual(queue.map((q) => q.id), ["older", "foreign-path", "newer"], "submitted only, oldest first");
    assert.match(queue[0].receiptUrl ?? "", /\/storage\/v1\/object\/sign\/delivery-proofs\/deposits\//);
    assert.equal(queue[1].receiptUrl, null, "a path outside the rider's own folder is never signed");
    assert.equal(queue[2].receiptUrl, null);
    assert.equal(queue[0].managerName, "Anil Manager");
  });

  await group("data: disputing needs a note (3+ characters) the rider can read; a disputed deposit stays out of 'deposited' and the day reads disputed (Review Focus 4)", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 1000, collected: 1000, collectedAt: new Date().toISOString() });
    const dep = (await x.submitDeposit(R1, { amount: 500, method: "cash" })) as { id: string };
    for (const note of [undefined, "", "   ", "ab", "x".repeat(501)]) {
      assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "dispute", note), { ok: false, error: "note_required" });
    }
    assert.equal(t("cash_deposits")[0].status, "submitted", "no note, no dispute");
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, dep.id, "dispute", "  Only 400 reached me "), { ok: true });
    const row = t("cash_deposits")[0];
    assert.deepEqual([row.status, row.decision_note, row.decided_by], ["disputed", "Only 400 reached me", MGR]);
    assert.equal(t("cod_handovers").length, 0, "disputing records no handover");
    const s = await x.getRiderCashSummary(R1);
    assert.deepEqual([s.depositedTotal, s.pending, s.submittedAwaiting], [0, 1000, 0]);
    assert.equal(s.days.find((d) => d.day === today)?.status, "disputed");
    assert.equal(s.days.find((d) => d.day === today)?.note, "Only 400 reached me");
    const list = await x.listRiderDeposits(R1);
    assert.deepEqual([list[0].status, list[0].decisionNote], ["disputed", "Only 400 reached me"]);
    // the cash can be declared again
    assert.equal((await x.submitDeposit(R1, { amount: 500, method: "cash" })).ok, true);
  });

  await group("data: withdrawing — own submitted deposit only; another rider's is 'not found'; a decided one is refused", async () => {
    reset();
    seedProfiles();
    const mine = seedDeposit(R1, { amount: 10 });
    const theirs = seedDeposit(R2, { amount: 10 });
    const confirmed = seedDeposit(R1, { amount: 10, status: "confirmed", handover_id: "h" });
    assert.deepEqual(await x.withdrawDeposit(R1, theirs.id), { ok: false, error: "not_found" });
    assert.equal(theirs.status, "submitted", "untouched");
    assert.deepEqual(await x.withdrawDeposit(R1, crypto.randomUUID()), { ok: false, error: "not_found" });
    assert.deepEqual(await x.withdrawDeposit(R1, confirmed.id), { ok: false, error: "already_decided" });
    assert.deepEqual(await x.withdrawDeposit(R1, mine.id), { ok: true });
    assert.equal(mine.status, "withdrawn");
    assert.deepEqual(await x.withdrawDeposit(R1, mine.id), { ok: false, error: "already_decided" });
    // a withdrawn deposit cannot then be confirmed
    assert.deepEqual(await x.decideDeposit({ id: MGR, role: "manager" }, mine.id, "confirm"), { ok: false, error: "already_decided" });
  });

  await group("data: raising a dispute — a real day within 90 days, a message, an optional whole-rupee claim, one open per day", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    const raise = (input: { day: string; claimedAmount?: number; message: string }) => x.raiseCashDispute(R1, input, now);
    for (const day of ["2026-10-23", "2026-02-30", "garbage", "2026-07-01", ""]) {
      assert.deepEqual(await raise({ day, message: "x" }), { ok: false, error: "invalid_day" }, day);
    }
    for (const message of ["", "   ", "m".repeat(501)]) {
      assert.deepEqual(await raise({ day: "2026-10-21", message }), { ok: false, error: "message_required" });
    }
    for (const claimedAmount of [-1, 1.5, 2_000_000]) {
      assert.deepEqual(await raise({ day: "2026-10-21", message: "x", claimedAmount }), { ok: false, error: "invalid_amount" });
    }
    assert.equal(t("cash_disputes").length, 0);
    const ok = await raise({ day: "2026-10-21", claimedAmount: 700, message: " I collected 700 " });
    assert.equal(ok.ok, true);
    assert.deepEqual(
      [t("cash_disputes")[0].driver_id, t("cash_disputes")[0].day, t("cash_disputes")[0].claimed_amount, t("cash_disputes")[0].message, t("cash_disputes")[0].status],
      [R1, "2026-10-21", 700, "I collected 700", "open"]
    );
    assert.deepEqual(await raise({ day: "2026-10-21", message: "again" }), { ok: false, error: "already_open" });
    assert.equal((await raise({ day: "2026-10-20", message: "another day" })).ok, true);
    assert.equal((await raise({ day: "2026-10-22", message: "today", claimedAmount: 0 })).ok, true, "today is allowed, and 0 is a claim");
    assert.equal((await x.raiseCashDispute(R2, { day: "2026-10-21", message: "another rider, same day" }, now)).ok, true);
    // the rider reads only their own
    const mine = await x.listRiderDisputes(R1);
    assert.equal(mine.length, 3);
    assert.ok(mine.every((d) => ["2026-10-20", "2026-10-21", "2026-10-22"].includes(d.day)));
  });

  await group("data: managers see open disputes first and resolve them once with what was decided", async () => {
    reset();
    seedProfiles();
    t("cash_disputes").push(
      { id: "resolved-1", driver_id: R1, day: "2026-10-18", status: "resolved", resolution: "fixed", message: "m", claimed_amount: null, created_at: "2026-10-19T00:00:00Z" },
      { id: "open-new", driver_id: R2, day: "2026-10-21", status: "open", resolution: null, message: "m", claimed_amount: 5, created_at: "2026-10-22T00:00:00Z" },
      { id: "open-old", driver_id: R1, day: "2026-10-20", status: "open", resolution: null, message: "m", claimed_amount: null, created_at: "2026-10-21T00:00:00Z" }
    );
    const list = await x.listCashDisputes();
    assert.deepEqual(list.map((d) => d.id), ["open-old", "open-new", "resolved-1"]);
    assert.equal(list[0].riderName, "Ravi Kumar");
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, "open-old", "  "), { ok: false, error: "resolution_required" });
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, "open-old", "Corrected to 700"), { ok: false, error: "not_found" }, "ids in this fixture are not uuids");
    const real = crypto.randomUUID();
    t("cash_disputes").push({ id: real, driver_id: R1, day: "2026-10-20", status: "open", message: "m", created_at: "2026-10-21T00:00:00Z" });
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, real, "Corrected to 700"), { ok: true });
    const row = t("cash_disputes").find((d) => d.id === real)!;
    assert.deepEqual([row.status, row.resolution, row.resolved_by], ["resolved", "Corrected to 700", MGR]);
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, real, "again"), { ok: false, error: "already_resolved" });
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, crypto.randomUUID(), "x"), { ok: false, error: "not_found" });
  });

  await group("A-minor 1: two reports of the same day at once - the database's one-open-per-day index refuses the second, answered as already_open", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    // the other request's insert lands after this one's "is one open?" read
    mode.beforeInsert = (table) => {
      if (table !== "cash_disputes") return;
      mode.beforeInsert = null;
      t("cash_disputes").push({ id: crypto.randomUUID(), driver_id: R1, day: "2026-10-21", status: "open", message: "the other tap", created_at: now.toISOString() });
    };
    assert.deepEqual(await x.raiseCashDispute(R1, { day: "2026-10-21", message: "short by 200" }, now), { ok: false, error: "already_open" });
    assert.equal(t("cash_disputes").length, 1, "one open dispute for the day");
    assert.equal(t("support_tickets").length, 0, "the refused report filed no ticket");
  });

  // ---- I-5: a dispute files a linked ticket, alerts ops; resolving tells the rider ----
  const nu = await import("../../src/lib/notifications/notify-user");
  const pushes: { userIds: string[]; title: string; body: string; data: Row }[] = [];
  nu.pushTransport.configured = () => true;
  nu.pushTransport.send = async (target, heading, message, opts = {}) => {
    const tg = target as { userIds?: (string | null | undefined)[] };
    pushes.push({
      userIds: (tg.userIds ?? []).filter(Boolean) as string[],
      title: typeof heading === "string" ? heading : heading.en,
      body: typeof message === "string" ? message : message.en,
      data: ((opts as Row).data ?? {}) as Row,
    });
    return true;
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));
  await group("I-5: raising a dispute files a cash_reconciliation ticket linked to it and alerts every manager and admin", async () => {
    reset();
    seedProfiles();
    t("profiles").push({ id: "00000000-0000-4000-8000-0000000000a9", role: "admin", full_name: "Admin" });
    pushes.length = 0;
    const now = new Date("2026-10-22T10:00:00Z");
    const r = await x.raiseCashDispute(R1, { day: "2026-10-21", claimedAmount: 700, message: "I collected 700, not 900" }, now);
    assert.ok(r.ok);
    if (!r.ok) return;
    await settle();
    const tickets = t("support_tickets");
    assert.equal(tickets.length, 1, "one linked ticket");
    assert.deepEqual(
      [tickets[0].requester_id, tickets[0].requester_role, tickets[0].category, tickets[0].cash_dispute_id],
      [R1, "rider", "cash_reconciliation", r.id]
    );
    assert.match(tickets[0].subject, /21 Oct 2026/);
    const first = t("support_messages").find((m) => m.ticket_id === tickets[0].id);
    assert.ok(first && /I collected 700, not 900/.test(first.body) && /₹700/.test(first.body), "the rider's words and claim open the thread");
    const ops = pushes.filter((p) => p.userIds.includes(MGR));
    assert.equal(ops.length, 1, "ops alerted once");
    assert.deepEqual([...ops[0].userIds].sort(), [MGR, MGR2, "00000000-0000-4000-8000-0000000000a9"].sort(), "managers and admins");
    assert.match(ops[0].body, /Ravi Kumar/);
    assert.match(ops[0].body, /21 Oct 2026/);
    assert.ok(!pushes.some((p) => p.userIds.includes(R1)), "the rider is not pushed about their own report");
  });
  await group("I-5: a refused dispute files no ticket and alerts nobody", async () => {
    reset();
    seedProfiles();
    pushes.length = 0;
    const now = new Date("2026-10-22T10:00:00Z");
    await x.raiseCashDispute(R1, { day: "2026-10-21", message: "first" }, now);
    await settle();
    pushes.length = 0;
    assert.deepEqual(await x.raiseCashDispute(R1, { day: "2026-10-21", message: "again" }, now), { ok: false, error: "already_open" });
    await settle();
    assert.equal(t("support_tickets").length, 1);
    assert.equal(pushes.length, 0);
  });
  await group("I-5: resolving a dispute tells the rider (cash, /more/cash, plain English) and closes its linked ticket", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    const r = await x.raiseCashDispute(R1, { day: "2026-10-21", message: "short by 200" }, now);
    assert.ok(r.ok);
    if (!r.ok) return;
    await settle();
    pushes.length = 0;
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, r.id, "Corrected to 700"), { ok: true });
    await settle();
    const inbox = t("user_notifications").filter((n) => n.user_id === R1);
    assert.equal(inbox.length, 1, "one inbox row");
    assert.equal(inbox[0].category, "cash");
    assert.equal(inbox[0].data.url, "/more/cash");
    assert.equal(inbox[0].title, "Cash report resolved");
    assert.equal(inbox[0].body, "Your cash report for 21 Oct 2026 was resolved. Corrected to 700");
    const toRider = pushes.filter((p) => p.userIds.includes(R1));
    assert.equal(toRider.length, 1, "pushed");
    assert.equal(toRider[0].data.category, "cash");
    assert.equal(t("support_tickets")[0].status, "resolved", "the linked ticket is closed with it");
    pushes.length = 0;
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, r.id, "again"), { ok: false, error: "already_resolved" });
    await settle();
    assert.equal(pushes.length, 0, "a second resolve tells nobody");
  });

  await group("data: managers a rider can name — id and name only", async () => {
    reset();
    seedProfiles();
    const managers = await x.listDepositManagers();
    assert.deepEqual(managers.map((m) => m.name).sort(), ["Anil Manager", "Meena Manager"]);
    assert.deepEqual(Object.keys(managers[0]).sort(), ["id", "name"]);
  });

  await group("data: reminders — over the limit or held too long, at most once in 6 hours, claimed atomically", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    // R1: ₹6000 collected an hour ago -> over the limit
    seedDelivery(1, R1, { total: 6000, collected: 6000, collectedAt: hoursAgo(now, 1) });
    // R2: ₹100 collected 30 hours ago, nothing deposited -> too long
    seedDelivery(2, R2, { total: 100, collected: 100, collectedAt: hoursAgo(now, 30) });
    // R3: ₹100 collected an hour ago -> fine
    seedDelivery(3, R3, { total: 100, collected: 100, collectedAt: hoursAgo(now, 1) });
    // R4: collected a lot 40 hours ago and deposited all of it -> nothing pending
    seedDelivery(4, R4, { total: 9000, collected: 9000, collectedAt: hoursAgo(now, 40) });
    seedHandover(R4, 9000, "2026-10-21");
    const sent: { id: string; pending: number; reason: string }[] = [];
    const notify = async (id: string, c: { pending: number; reason: "limit" | "hours" | "both"; hours: number }) => {
      sent.push({ id, pending: c.pending, reason: c.reason });
    };
    assert.equal(await x.sendCashReminders(now, notify), 2);
    assert.deepEqual(sent.map((s) => [s.id, s.pending, s.reason]).sort(), [[R1, 6000, "limit"], [R2, 100, "hours"]].sort());
    // again straight away, and 5h59m later: throttled
    assert.equal(await x.sendCashReminders(new Date(now.getTime() + 60_000), notify), 0);
    assert.equal(await x.sendCashReminders(new Date(now.getTime() + 359 * 60_000), notify), 0);
    assert.equal(sent.length, 2);
    // 6 hours later: both again
    assert.equal(await x.sendCashReminders(new Date(now.getTime() + 361 * 60_000), notify), 2);
    // two sweeps racing: one push per rider
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 6000, collected: 6000, collectedAt: hoursAgo(now, 1) });
    const raced: string[] = [];
    const record = async (id: string) => { raced.push(id); };
    const counts = await Promise.all([x.sendCashReminders(now, record), x.sendCashReminders(now, record), x.sendCashReminders(now, record)]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 1);
    assert.deepEqual(raced, [R1]);
  });

  await group("data: reminders — the throttle, 'still a rider' and 'a deposit already waiting' are applied BEFORE the batch of 50 is cut", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    const mkRider = (n: number): string => {
      const id = `00000000-0000-4000-8000-00000000${String(1000 + n).padStart(4, "0")}`;
      t("profiles").push({ id, role: "driver", full_name: `Rider ${n}` });
      seedDelivery(2000 + n, id, { total: 6000 + n, collected: 6000 + n, collectedAt: hoursAgo(now, 1) });
      return id;
    };
    // 55 riders reminded an hour ago (throttled) outrank 5 new ones by amount: a slice-then-throttle would send 0.
    const throttled = Array.from({ length: 55 }, (_, i) => mkRider(100 + i));
    for (const id of throttled) t("cash_reminders").push({ driver_id: id, last_sent_at: hoursAgo(now, 1) });
    const fresh = Array.from({ length: 5 }, (_, i) => mkRider(i));
    const sent: string[] = [];
    const notify = async (id: string) => { sent.push(id); };
    assert.equal(await x.sendCashReminders(now, notify), 5, "the throttled riders did not use up the batch");
    assert.deepEqual([...sent].sort(), [...fresh].sort());

    // 120 due and unthrottled: exactly 50 pushes go, and they are real pushes
    reset();
    seedProfiles();
    const many = Array.from({ length: 120 }, (_, i) => mkRider(i));
    sent.length = 0;
    assert.equal(await x.sendCashReminders(now, notify), 50);
    assert.equal(new Set(sent).size, 50);
    assert.equal(t("cash_reminders").length, 50, "only the riders actually pushed are marked");
    // the next sweep (6h+ later is NOT needed for the other 70) carries on with riders not yet reminded
    assert.equal(await x.sendCashReminders(new Date(now.getTime() + 60_000), notify), 50);
    assert.equal(new Set(sent).size, 100);
    void many;
  });

  await group("data: no reminder for a profile that is no longer a rider, or when the rider's waiting deposit already covers the cash", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    const former = "00000000-0000-4000-8000-0000000000f1";
    t("profiles").push({ id: former, role: "customer", full_name: "Was a rider" });
    seedDelivery(1, former, { total: 7000, collected: 7000, collectedAt: hoursAgo(now, 1) });
    seedDelivery(2, R1, { total: 6000, collected: 6000, collectedAt: hoursAgo(now, 1) });
    seedDelivery(3, R2, { total: 6000, collected: 6000, collectedAt: hoursAgo(now, 1) });
    seedDelivery(4, R3, { total: 6000, collected: 6000, collectedAt: hoursAgo(now, 1) });
    seedDeposit(R1, { amount: 6000 }); // submitted, covers all of it: a manager is about to confirm
    seedDeposit(R2, { amount: 5999 }); // does not cover it
    seedDeposit(R3, { amount: 6000, status: "disputed", decision_note: "no" }); // disputed does not cover anything
    const sent: string[] = [];
    assert.equal(await x.sendCashReminders(now, async (id) => { sent.push(id); }), 2);
    assert.deepEqual([...sent].sort(), [R2, R3].sort());
    assert.ok(!t("cash_reminders").some((r) => r.driver_id === former || r.driver_id === R1), "skipped riders are not marked as reminded");
  });

  await group("data: reminders respect the thresholds — 0 switches a rule off, and the admin's numbers apply", async () => {
    reset();
    seedProfiles();
    const now = new Date("2026-10-22T10:00:00Z");
    seedDelivery(1, R1, { total: 3000, collected: 3000, collectedAt: hoursAgo(now, 30) });
    const sent: string[] = [];
    const notify = async (id: string) => { sent.push(id); };
    t("platform_settings")[0].rider_cash_limit = 0;
    t("platform_settings")[0].rider_cash_max_hours = 0;
    assert.equal(await x.sendCashReminders(now, notify), 0, "both rules off");
    t("platform_settings")[0].rider_cash_max_hours = 48;
    assert.equal(await x.sendCashReminders(now, notify), 0, "30h is inside 48h");
    t("platform_settings")[0].rider_cash_limit = 2000;
    assert.equal(await x.sendCashReminders(now, notify), 1, "3000 is over a 2000 limit");
    const s = await x.getRiderCashSummary(R1, now);
    assert.deepEqual([s.limit, s.maxHours, s.overLimit, s.overHours], [2000, 48, true, false]);
  });

  await group("data: resolving a dispute — an unreadable row is an error, not 'already resolved' or 'not found'", async () => {
    reset();
    seedProfiles();
    const id = crypto.randomUUID();
    t("cash_disputes").push({ id, driver_id: R1, day: "2026-10-20", status: "resolved", resolution: "done", message: "m", created_at: "2026-10-21T00:00:00Z" });
    assert.deepEqual(await x.resolveCashDispute({ id: MGR }, id, "again"), { ok: false, error: "already_resolved" });
    mode.failReads.add("cash_disputes");
    // the update (a PATCH) finds nothing to change; the follow-up read then fails
    await assert.rejects(x.resolveCashDispute({ id: MGR }, id, "again"));
    mode.failReads.delete("cash_disputes");
    mode.missingTables.add("cash_disputes");
    await assert.rejects(x.resolveCashDispute({ id: MGR }, id, "again"), (e: unknown) => isRiderSchemaPending(e));
  });

  await group("data: a database without 0085 — every read and write answers migration_pending; the sweep part and the thresholds degrade quietly", async () => {
    reset();
    seedProfiles();
    seedDelivery(1, R1, { total: 100, collected: 100, collectedAt: new Date().toISOString() });
    for (const table of ["cash_deposits", "cash_disputes"]) mode.missingTables.add(table);
    const pending = (e: unknown) => isRiderSchemaPending(e);
    await assert.rejects(x.getRiderCashSummary(R1), pending);
    await assert.rejects(x.listRiderDeposits(R1), pending);
    await assert.rejects(x.listRiderDisputes(R1), pending);
    await assert.rejects(x.submitDeposit(R1, { amount: 10, method: "cash" }), pending);
    await assert.rejects(x.withdrawDeposit(R1, crypto.randomUUID()), pending);
    await assert.rejects(x.raiseCashDispute(R1, { day: istDateKey(), message: "x" }), pending);
    await assert.rejects(x.decideDeposit({ id: MGR, role: "manager" }, crypto.randomUUID(), "confirm"), pending);
    await assert.rejects(x.listDepositQueue(), pending);
    await assert.rejects(x.listCashDisputes(), pending);
    mode.missingTables.add("cash_reminders");
    assert.equal(await x.sendCashReminders(new Date(Date.now() + 90 * 86_400_000), async () => {}), 0, "never throws into the sweep");
    // collections only need 0047 and still work
    mode.missingTables.clear();
    assert.equal((await x.listRiderCollections(R1, {})).items.length, 1);
    // thresholds: no 0085 column -> the defaults
    const missing = (await x.readCashThresholds({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => ({ overrideTypes: async () => ({ data: null, error: { code: "42703" } }) }) }) }) }),
    } as never));
    assert.deepEqual(missing, { limit: 5000, maxHours: 24 });
  });
}

// ---------------------------------------------------------------------------
// 3. the route doors, from source
// ---------------------------------------------------------------------------
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

async function doorsTier(): Promise<void> {
  const root = join(process.cwd(), "src", "app", "api", "rider", "cash");
  const routes = walk(root).filter((p) => p.endsWith("route.ts"));
  await group("doors: the six /api/rider/cash routes exist", () => {
    const names = routes.map((p) => p.slice(root.length + 1).replace(/\\/g, "/")).sort();
    assert.deepEqual(names, ["collections/route.ts", "deposits/[id]/route.ts", "deposits/route.ts", "disputes/route.ts", "managers/route.ts", "summary/route.ts"]);
  });
  await group("doors: every handler opens with riderCashGate (role check + rate limit) before it reads a body or a param", () => {
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      const handlers = [...src.matchAll(/export async function (GET|POST|DELETE|PUT|PATCH)\b/g)];
      assert.ok(handlers.length > 0, file);
      for (const h of handlers) {
        const start = h.index as number;
        const nextHandler = src.indexOf("export async function", start + 10);
        const body = src.slice(start, nextHandler === -1 ? undefined : nextHandler);
        const gate = body.indexOf("riderCashGate(");
        assert.ok(gate > -1, `${file} ${h[1]} has no gate`);
        for (const read of ["request.json", "request.formData", "await params", "createAdminClient", "request.url", "new URL("]) {
          const at = body.indexOf(read);
          assert.ok(at === -1 || at > gate, `${file} ${h[1]} reads ${read} before the gate`);
        }
      }
      assert.ok(!/createAdminClient/.test(src), `${file}: routes go through the data layer, not the admin client`);
      assert.ok(!/driver_?id["']?\s*[:=]\s*(body|fields|params)/i.test(src), `${file}: the rider id is never taken from the request`);
    }
  });
  await group("doors: the gate is requireRiderApi + a per-rider rate limit", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "auth", "rider-cash-route.ts"), "utf8");
    assert.ok(src.indexOf("requireRiderApi()") > -1 && src.indexOf("rateLimit(") > src.indexOf("requireRiderApi()"));
    assert.match(src, /rider-cash:\$\{route\}:\$\{driverId\}/);
  });
  await group("doors: the admin cash ledger tells a missing migration (0085) from any other failure", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "admin", "cash-ledger", "page.tsx"), "utf8");
    assert.ok(src.includes("isRiderSchemaPending(e)") && /state: isRiderSchemaPending\(e\) \? "pending" : "failed"/.test(src));
    assert.ok(/need migration 0085/.test(src) && /Could not load/.test(src));
    assert.ok(!/\.catch\(\(\) => null\)/.test(src), "no more swallow-everything catch");
  });
  await group("doors: the manager actions check the role and the feature switch, then rate-limit, before touching the data layer", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "manager", "cash", "actions.ts"), "utf8");
    for (const fn of ["decideDepositAction", "resolveCashDisputeAction"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const end = body.indexOf("\nexport async function", 10);
      const text = end === -1 ? body : body.slice(0, end);
      const role = text.indexOf('requireRole(["manager", "admin"])');
      const limit = text.indexOf("rateLimit(");
      const call = Math.max(text.indexOf("await decideDeposit("), text.indexOf("await resolveCashDispute("));
      assert.ok(role > -1 && role < limit && limit < call, `${fn}: role check, then rate limit, then the write`);
      assert.ok(text.includes("staffFeatureOn"), `${fn} honours the manager.cash switch`);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. route contract against the dev server
// ---------------------------------------------------------------------------
async function request(path: string, init: { method?: string; cookie?: string; body?: unknown; raw?: string } = {}): Promise<{ status: number; json: Row | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
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

const ID = "11111111-2222-4333-8444-555555555555";
const CALLS: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/api/rider/cash/summary" },
  { method: "GET", path: "/api/rider/cash/collections" },
  { method: "GET", path: "/api/rider/cash/deposits" },
  { method: "POST", path: "/api/rider/cash/deposits", body: { amount: 1, method: "cash" } },
  { method: "DELETE", path: `/api/rider/cash/deposits/${ID}` },
  { method: "GET", path: "/api/rider/cash/disputes" },
  { method: "POST", path: "/api/rider/cash/disputes", body: { day: "2026-01-01", message: "x" } },
  { method: "GET", path: "/api/rider/cash/managers" },
];

async function contract(): Promise<void> {
  try {
    await fetch(`${BASE}/api/rider/me`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }
  for (const c of CALLS) {
    const res = await request(c.path, { method: c.method, body: c.body });
    check(`no cookie -> 401  ${c.method} ${c.path}`, res.status === 401 && res.json?.error === "unauthenticated", res);
  }
  if (CUSTOMER_EMAIL && CUSTOMER_PASSWORD) {
    const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
    for (const c of CALLS) {
      const res = await request(c.path, { method: c.method, body: c.body, cookie });
      check(`customer -> 403 not_rider  ${c.method} ${c.path}`, res.status === 403 && res.json?.error === "not_rider", res);
    }
  } else {
    skip("customer 403 checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
  }

  if (!RIDER_EMAIL || !RIDER_PASSWORD) {
    skip("rider checks (400s, 200 shapes or 503 migration_pending): QA_RIDER_EMAIL / QA_RIDER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(RIDER_EMAIL, RIDER_PASSWORD);
  const is = (res: { status: number; json: Row | null }, status: number, error: string) => res.status === status && res.json?.error === error;
  const post = (path: string, body: unknown) => request(path, { method: "POST", body, cookie });

  // malformed input is refused before the database is reached: nothing here writes
  const dep = "/api/rider/cash/deposits";
  check("POST deposits {} -> 400 invalid_amount", is(await post(dep, {}), 400, "invalid_amount"));
  check("POST deposits amount 0 -> 400 invalid_amount", is(await post(dep, { amount: 0, method: "cash" }), 400, "invalid_amount"));
  check("POST deposits amount 1.5 -> 400 invalid_amount", is(await post(dep, { amount: 1.5, method: "cash" }), 400, "invalid_amount"));
  check("POST deposits no method -> 400 invalid_method", is(await post(dep, { amount: 5 }), 400, "invalid_method"));
  check("POST deposits method 'cheque' -> 400 invalid_method", is(await post(dep, { amount: 5, method: "cheque" }), 400, "invalid_method"));
  check("POST deposits UPI with no reference -> 400 reference_required (or 503 before 0085)",
    [400, 503].includes((await post(dep, { amount: 5, method: "upi" })).status));
  check("POST deposits not JSON -> 400 invalid_body", is(await request(dep, { method: "POST", cookie, raw: "nope", body: undefined }), 400, "invalid_body") ||
    (await request(dep, { method: "POST", cookie, raw: "nope" })).status === 400);
  const huge = await post(dep, { amount: 999_999_999, method: "cash" });
  check("POST deposits more than the rider holds -> 409 exceeds_pending (or 400 / 503)", [409, 400, 503].includes(huge.status), huge);
  if (huge.status === 409) {
    check("...with the held and available amounts", typeof huge.json?.pending === "number" && typeof huge.json?.available === "number", huge);
  }
  const dis = "/api/rider/cash/disputes";
  check("POST disputes {} -> 400 invalid_day", is(await post(dis, {}), 400, "invalid_day"));
  check("POST disputes no message -> 400 message_required", is(await post(dis, { day: "2026-01-01" }), 400, "message_required"));
  check("POST disputes bad day -> 400 invalid_day (or 503)", [400, 503].includes((await post(dis, { day: "2026-02-30", message: "x" })).status));
  check("DELETE deposits/not-a-uuid -> 400 invalid_id", is(await request("/api/rider/cash/deposits/not-a-uuid", { method: "DELETE", cookie }), 400, "invalid_id"));
  const gone = await request(`/api/rider/cash/deposits/${ID}`, { method: "DELETE", cookie });
  check("DELETE a deposit that is not the rider's -> 404 not_found (or 503)", is(gone, 404, "not_found") || gone.status === 503, gone);
  const col = "/api/rider/cash/collections";
  const get = (path: string) => request(path, { cookie });
  check("GET collections?from only -> 400 invalid_range", is(await get(`${col}?from=2026-01-01`), 400, "invalid_range") || (await get(`${col}?from=2026-01-01`)).status === 503);
  check("GET collections bad date -> 400 invalid_date", is(await get(`${col}?from=2026-1-01&to=2026-01-02`), 400, "invalid_date"));
  check("GET collections bad cursor -> 400 invalid_cursor", is(await get(`${col}?cursor=zzz!`), 400, "invalid_cursor"));

  for (const path of ["/api/rider/cash/summary", col, dep, dis, "/api/rider/cash/managers"]) {
    const res = await get(path);
    if (res.status === 503) check(`GET ${path} before 0085 -> 503 migration_pending`, res.json?.error === "migration_pending", res);
    else check(`GET ${path} -> 200`, res.status === 200, res);
  }
  const summary = await get("/api/rider/cash/summary");
  if (summary.status === 200) {
    const keys = ["toCollect", "collectedToday", "depositedToday", "collectedTotal", "depositedTotal", "pending", "submittedAwaiting", "oldestUndepositedAt", "overLimit", "overHours", "limit", "maxHours", "days"];
    check("summary has exactly the documented keys", JSON.stringify(Object.keys(summary.json ?? {}).sort()) === JSON.stringify([...keys].sort()), summary.json);
  }
}

async function main(): Promise<void> {
  console.log("-- 1. pure maths");
  await pureTier();
  console.log("-- 2. data layer (fake PostgREST + storage)");
  await dataTier();
  console.log("-- 3. route doors");
  await doorsTier();
  console.log("-- 4. route contract");
  await contract();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
