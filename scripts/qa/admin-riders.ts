/**
 * QA — admin Riders section (Phase 3 Task 3): the action-input parsers, the
 * payout preview, the data layer against a fake PostgREST, the structural
 * guarantees on the server actions, and the route contract.
 *
 *   npm run test:admin-riders   # tsx --conditions=react-server; the contract part needs `npm run dev`
 *
 *   BASE                                        default http://localhost:3005
 *   QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD    any non-admin account
 *
 * Tiers:
 *
 *   1. Pure (`lib/rider/admin-money.ts`). `parseAdjustment` and `parsePayout`
 *      are what every action runs first, so the refusals
 *      the database would also make (a negative deduction, a zero adjustment,
 *      a payout paid before
 *      its period ends) are checked here as sentences an operator can read.
 *      `previewPayout` mirrors the database's selection rule (`_rider_payout_preview`).
 *   2. Structure. Every exported function of the three action files is a
 *      server action: the file is `"use server"` and each function's first
 *      statement is `await requireRole("admin")` (AGENTS.md rule 3), with the
 *      rate limit straight after it.
 *   3. The data layer (`data-access/admin-riders.ts`) against an in-memory
 *      PostgREST: the Riders list (phase, in-flight order, today's count,
 *      pending payout), the payout read back after recording, the rule writes
 *      (created_by is the admin; period and starts_on are never sent on an
 *      edit), and a database without 0083 / 0081.
 *   4. Route contract against the dev server: signed out, and a non-admin,
 *      are both turned away from every new page (and so from the actions,
 *      which are gated by the same `requireRole`). Server actions have no
 *      stable URL to post to, so the action-level `forbidden` is tier 2's
 *      structural check. SKIPs when the server or the QA account is missing
 *      (ruling R2: no database has 0083).
 *
 * Never sends push/SMS/OTP and never writes live data: every ONESIGNAL
 * variable is removed before any module loads, the fake is the only thing
 * written to, and the contract part only issues GETs.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const TODAY = "2026-10-22";

// ---------------------------------------------------------------------------
// 1. pure
// ---------------------------------------------------------------------------
async function pureTier(): Promise<void> {
  const m = await import("../../src/lib/rider/admin-money");

  const adj = (over: Record<string, string> = {}) =>
    m.parseAdjustment(
      form({ kind: "salary", amount: "500", reason: "October salary", effectiveOn: TODAY, ...over }),
      { today: TODAY }
    );
  const bad = (r: { ok: boolean; error?: string }) => r.ok === false && typeof r.error === "string" && r.error.length > 8;

  await group("parseAdjustment: a salary entry", () => {
    const r = adj();
    assert.ok(r.ok);
    assert.deepEqual(r.value, { kind: "salary", amount: 500, reason: "October salary", orderCode: null, effectiveOn: TODAY });
  });
  await group("parseAdjustment: a bonus is refused (rule book: fixed salary only)", () => {
    assert.ok(bad(adj({ kind: "bonus" })));
    assert.deepEqual([...m.ADJUSTMENT_KINDS], ["salary", "adjustment", "deduction"]);
  });
  await group("parseAdjustment: a deduction is stored positive; a negative or zero one is refused", () => {
    const ok = adj({ kind: "deduction", amount: "150" });
    assert.ok(ok.ok && ok.value.amount === 150);
    assert.ok(bad(adj({ kind: "deduction", amount: "-150" })), "negative deduction");
    assert.ok(bad(adj({ kind: "deduction", amount: "0" })), "zero deduction");
  });
  await group("parseAdjustment: an adjustment is signed and non-zero", () => {
    const up = adj({ kind: "adjustment", amount: "20" });
    const down = adj({ kind: "adjustment", amount: "-75.50" });
    assert.ok(up.ok && up.value.amount === 20);
    assert.ok(down.ok && down.value.amount === -75.5);
    assert.ok(bad(adj({ kind: "adjustment", amount: "0" })), "adjustment 0");
    assert.ok(bad(adj({ kind: "adjustment", amount: "0.00" })), "adjustment 0.00");
  });
  await group("parseAdjustment: salary must be positive", () => {
    assert.ok(bad(adj({ kind: "salary", amount: "0" })));
    const salary = adj({ kind: "salary", amount: "18,000" });
    assert.ok(salary.ok && salary.value.amount === 18000, "thousands separators are read");
  });
  await group("parseAdjustment: amounts are real, two-decimal and bounded", () => {
    for (const amount of ["", "abc", "12.345", "1e3", "NaN", "Infinity", "--5", "5-", "1000000.01", "99999999999"]) {
      assert.ok(bad(adj({ amount })), `amount ${JSON.stringify(amount)}`);
    }
    const edge = adj({ amount: "1000000" });
    assert.ok(edge.ok, "the ceiling itself is allowed");
    const paise = adj({ amount: "0.01" });
    assert.ok(paise.ok && paise.value.amount === 0.01);
  });
  await group("parseAdjustment: kind and reason", () => {
    assert.ok(bad(adj({ kind: "penalty" })), "unknown kind");
    assert.ok(bad(adj({ kind: "" })), "no kind");
    assert.ok(bad(adj({ reason: "" })), "no reason");
    assert.ok(bad(adj({ reason: "   " })), "blank reason");
    assert.ok(bad(adj({ reason: "x".repeat(301) })), "reason too long");
    const trimmed = adj({ reason: "  Late return  " });
    assert.ok(trimmed.ok && trimmed.value.reason === "Late return");
  });
  await group("parseAdjustment: date", () => {
    assert.ok(bad(adj({ effectiveOn: "2026-02-30" })), "not a real day");
    assert.ok(bad(adj({ effectiveOn: "22/10/2026" })), "wrong format");
    assert.ok(bad(adj({ effectiveOn: "2026-10-23" })), "after today");
    const blank = adj({ effectiveOn: "" });
    assert.ok(blank.ok && blank.value.effectiveOn === TODAY, "blank = today");
    const past = adj({ effectiveOn: "2026-09-01" });
    assert.ok(past.ok, "a past date is fine");
  });
  await group("parseAdjustment: order code", () => {
    const a = adj({ orderCode: "#a1b2c3d4" });
    assert.ok(a.ok && a.value.orderCode === "A1B2C3D4", "normalised");
    const b = adj({ orderCode: "  a1b2c3d4 " });
    assert.ok(b.ok && b.value.orderCode === "A1B2C3D4");
    assert.ok(bad(adj({ orderCode: "not a code!" })));
    assert.ok(bad(adj({ orderCode: "ABC" })), "too short to be an order code");
    const none = adj({ orderCode: "" });
    assert.ok(none.ok && none.value.orderCode === null);
  });
  await group("parseAdjustment: a field that is a File, not text, is refused rather than stringified", () => {
    const f = form({ kind: "salary", amount: "5", reason: "r", effectiveOn: TODAY });
    f.set("reason", new File(["x"], "x.txt"));
    assert.ok(bad(m.parseAdjustment(f, { today: TODAY })));
  });

  // ---- payouts
  const pay = (over: Record<string, string> = {}) =>
    m.parsePayout(
      form({ periodEnd: "2026-10-21", method: "upi", reference: "UTR 4455", paidOn: TODAY, note: "Week 42", ...over }),
      { today: TODAY }
    );
  await group("parsePayout: a payout", () => {
    const r = pay();
    assert.ok(r.ok);
    assert.deepEqual(r.value, { periodEnd: "2026-10-21", method: "upi", reference: "UTR 4455", paidOn: TODAY, note: "Week 42" });
  });
  await group("parsePayout: reference and note are optional and trimmed to null", () => {
    const r = pay({ reference: "  ", note: "" });
    assert.ok(r.ok && r.value.reference === null && r.value.note === null);
  });
  await group("parsePayout: period end must be a real day, not after today", () => {
    assert.ok(bad(pay({ periodEnd: "" })));
    assert.ok(bad(pay({ periodEnd: "2026-13-01" })));
    assert.ok(bad(pay({ periodEnd: "2026-10-23" })), "after today");
    const today = pay({ periodEnd: TODAY });
    assert.ok(today.ok, "today itself is allowed");
  });
  await group("parsePayout: paid on is not before the period end, and not in the future", () => {
    assert.ok(bad(pay({ periodEnd: "2026-10-21", paidOn: "2026-10-20" })), "paid before the period ends");
    assert.ok(bad(pay({ paidOn: "2026-10-23" })), "paid in the future");
    assert.ok(bad(pay({ paidOn: "nope" })));
    const blank = pay({ paidOn: "" });
    assert.ok(blank.ok && blank.value.paidOn === TODAY, "blank = today");
  });
  await group("parsePayout: method", () => {
    for (const method of ["bank", "upi", "cash", "other"]) assert.ok(pay({ method }).ok, method);
    assert.ok(bad(pay({ method: "crypto" })));
    assert.ok(bad(pay({ method: "" })));
  });
  await group("parsePayout: paying now needs the reference and the reason the database requires", () => {
    const now = (over: Record<string, string> = {}) =>
      m.parsePayout(form({ periodEnd: "2026-10-21", method: "upi", reference: "UPI 1", paidOn: TODAY, note: "Week 42", ...over }), { today: TODAY, payNow: true });
    assert.ok(now().ok);
    assert.ok(bad(now({ reference: " " })), "no reference");
    assert.ok(bad(now({ note: "x" })), "no reason");
  });
  await group("parsePayout: lengths", () => {
    assert.ok(bad(pay({ reference: "r".repeat(121) })));
    assert.ok(bad(pay({ note: "n".repeat(301) })));
  });


  // ---- the preview
  const rec = (id: string, kind: string, date: string, amount: number, over: Row = {}) => ({
    id,
    kind,
    date,
    amount,
    reversesId: null,
    ...over,
  });
  const pending = [
    rec("r1", "delivery", "2026-10-20", 50),
    rec("r2", "delivery", "2026-10-22", 40),
    rec("a1", "incentive", "2026-10-20", 100),
    rec("d1", "deduction", "2026-10-21", -30),
    rec("x2", "adjustment", "2026-10-23", -40, { reversesId: "r2" }),
  ] as Parameters<typeof m.previewPayout>[0];
  await group("previewPayout: up to a date settles what is dated by then", () => {
    const p = m.previewPayout(pending, "2026-10-21");
    assert.deepEqual(p, { amount: 120, items: 3, payable: true });
  });
  await group("previewPayout: a reversal rides along with the earning it reverses (P3-R6)", () => {
    const p = m.previewPayout(pending, "2026-10-22");
    assert.deepEqual(p, { amount: 120, items: 5, payable: true }, "r2 + its reversal dated after the period end");
    const without = m.previewPayout(pending, "2026-10-19");
    assert.deepEqual(without, { amount: 0, items: 0, payable: false });
  });
  await group("previewPayout: a negative balance is not payable", () => {
    const p = m.previewPayout([rec("d1", "deduction", "2026-10-20", -30)] as typeof pending, "2026-10-21");
    assert.deepEqual(p, { amount: -30, items: 1, payable: false });
  });
  await group("previewPayout: ₹0 per-delivery rows still attach but are not listed as items", () => {
    const zeroes = [
      rec("z1", "delivery", "2026-10-20", 0),
      rec("z2", "delivery", "2026-10-20", 0),
      rec("zr", "adjustment", "2026-10-21", 0, { reversesId: "z2" }),
      rec("sal", "salary", "2026-10-20", 30000),
    ] as typeof pending;
    assert.deepEqual(m.previewPayout(zeroes, "2026-10-21"), { amount: 30000, items: 1, payable: true }, "only the salary is an item");
    assert.deepEqual(m.previewPayout(zeroes.slice(0, 3), "2026-10-21"), { amount: 0, items: 0, payable: false }, "nothing but ₹0 rows: nothing to pay");
  });
  await group("Add an entry defaults to Salary", () => {
    assert.equal(m.DEFAULT_ADJUSTMENT_KIND, "salary");
    assert.equal(m.ADJUSTMENT_KINDS[0], "salary", "first in the Type list");
    assert.ok(m.ADJUSTMENT_KINDS.includes(m.DEFAULT_ADJUSTMENT_KIND));
  });
  await group("previewPayout: sums in whole paise", () => {
    const p = m.previewPayout(
      [rec("a", "delivery", "2026-10-20", 0.1), rec("b", "delivery", "2026-10-20", 0.2)] as typeof pending,
      "2026-10-21"
    );
    assert.equal(p.amount, 0.3);
  });

  // ---- error sentences
  await group("riderPaymentMessage: the database's refusals read as sentences", () => {
    const codes = ["nothing_to_pay", "duplicate_pending", "same_person", "reference_required", "note_required", "already_decided", "not_found", "action_failed"];
    const all = codes.map((c) => m.riderPaymentMessage(c));
    assert.equal(new Set(all).size, codes.length, "each is its own sentence");
    for (const text of all) assert.doesNotMatch(text, /migration|void|batch|draft|gateway|_/i, text);
    assert.match(m.riderPaymentMessage("amount_changed", { amount: 205 }), /₹205/);
    assert.match(m.riderPaymentMessage("connection to db.internal failed"), /no money was recorded/, "an unknown code never echoes");
    assert.doesNotMatch(m.riderPaymentMessage("connection to db.internal failed"), /db\.internal/);
  });
  await group("writeErrorMessage: rules and adjustments", () => {
    assert.match(m.writeErrorMessage({ code: "42501", message: "permission denied for table rider_adjustments" }, "adjustment"), /not allowed|admin/i);
    assert.match(m.writeErrorMessage({ code: "PGRST205", message: "Could not find the table" }, "adjustment"), /set up/);
    assert.match(m.writeErrorMessage({ code: "23514", message: "violates check constraint" }, "rule"), /rejected|check/i);
    assert.doesNotMatch(m.writeErrorMessage({ code: "XX000", message: "secret host" }, "rule"), /secret host/);
  });
  await group("formatDay: the words an operator reads", () => {
    assert.equal(m.formatDay("2026-10-22"), "22 Oct 2026");
    assert.equal(m.formatDay("2026-01-05"), "5 Jan 2026");
  });
  await group("deliveryDetail: how a delivery was paid", () => {
    const base = { baseFee: 20, distanceKm: 4, distanceSource: "road", distanceFee: 12, minTopup: 0, tip: 5, tipInCash: false } as const;
    assert.equal(m.deliveryDetail(base), "₹20 base + ₹12 distance (4 km by road) + ₹5 tip");
    assert.equal(m.deliveryDetail({ ...base, distanceSource: "estimate", tipInCash: true, minTopup: 3 }), "₹20 base + ₹12 distance (4 km estimated) + ₹3 minimum top-up + ₹5 tip paid in cash (not in this amount)");
    assert.equal(m.deliveryDetail({ baseFee: 30, distanceKm: 0, distanceSource: null, distanceFee: 0, minTopup: 0, tip: 0, tipInCash: false }), "₹30 base - distance not recorded");
  });
  await group("formatMoney: rupees with two decimals only when needed", () => {
    assert.equal(m.formatMoney(1250), "₹1,250");
    assert.equal(m.formatMoney(1250.5), "₹1,250.50");
    assert.equal(m.formatMoney(-30), "-₹30");
    assert.equal(m.formatMoney(0), "₹0");
    assert.equal(m.formatMoney(123456.07), "₹1,23,456.07");
  });
}

// ---------------------------------------------------------------------------
// 2. structure of the server actions
// ---------------------------------------------------------------------------
const ACTION_FILES = [
  "src/app/admin/riders/[id]/money-actions.ts",
  "src/app/admin/riders/payments/actions.ts",
];

function exportedFunctions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export\s+async\s+function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const open = src.indexOf("{", src.indexOf(")", match.index + match[0].length) + 1);
    // the first statements are all that matter; take a generous slice
    out.push({ name: match[1], body: src.slice(open + 1, open + 1 + 400) });
  }
  return out;
}

async function structureTier(): Promise<void> {
  // P3-R11: riders are salaried; the per-delivery rate card stays in the
  // database at ₹0 but the console no longer edits it, and a posted value is
  // not written.
  {
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    const RATE_FIELDS = /riderBaseFee|riderKmIncluded|riderPerKm|riderMinPerDelivery/;
    const actions = read("src/app/admin/settings/actions.ts");
    const form = read("src/app/admin/settings/settings-form.tsx");
    const settings = read("src/lib/data-access/settings.ts");
    check("settings action reads none of the rate-card form fields", !RATE_FIELDS.test(actions));
    check("settings action carries the stored rate card through unchanged", /riderRateCard:\s*current\.riderRateCard/.test(actions));
    check("settings form has no rate-card inputs", !RATE_FIELDS.test(form));
    const moneyTab = read("src/app/admin/riders/[id]/money-tab.tsx");
    const moneyForms = read("src/app/admin/riders/[id]/money-forms.tsx");
    const moneyActions = read("src/app/admin/riders/[id]/money-actions.ts");
    const payments = read("src/lib/data-access/admin-rider-payments.ts");
    check("nothing in the console calls the one-person payout 0152 took away", !/record_rider_payout/.test(moneyActions + read("src/lib/data-access/admin-riders.ts") + payments));
    check("paying goes through the payment request, then its decision", moneyActions.indexOf("await createRiderPayoutRequest(") > 0 && moneyActions.indexOf("await decidePaymentRequest(") > moneyActions.indexOf("await createRiderPayoutRequest("));
    check("the one-step payment only runs under the one-admin rule", /const payNow = mode === true/.test(moneyActions) && /if \(!payNow\) \{/.test(moneyActions));
    check("Rider salaries is linked from the Riders page and the Money tab", /\/admin\/riders\/payments/.test(read("src/app/admin/riders/riders-view.tsx")) && /\/admin\/riders\/payments/.test(moneyTab));
    check("a database without payment requests gets a plain message", /aren&apos;t set up on this database yet/.test(read("src/app/admin/riders/payments/page.tsx")) && !/\b0\d{3}\b(?![^\n]*\*)/.test(read("src/app/admin/riders/payments/page.tsx").replace(/\/\*\*[\s\S]*?\*\//g, "")));
    check(
      "Money tab: no bonus, incentive or per-delivery figure (rule book: fixed salary only)",
      !/label="(Bonuses|Incentives|Per delivery|Total earned)"/.test(moneyTab) && /label="Salary"/.test(moneyTab)
    );
    check("Add an entry starts on the default kind (Salary), not a hard-coded Bonus", moneyForms.includes("(DEFAULT_ADJUSTMENT_KIND)") && !/setKind\("bonus"\)/.test(moneyForms));
    check(
      "settings Riders card says riders are salaried",
      form.includes("Riders are paid a fixed salary. Record salary and deductions on each rider&apos;s Money tab.")
    );
    const group = settings.slice(settings.indexOf('key: "platform_settings.rider_base_fee"'));
    const groupEnd = group.indexOf("\n  },");
    const rateGroup = group.slice(0, groupEnd);
    check("the rate-card group is still read (select kept)", /select:\s*"rider_base_fee, rider_km_included, rider_per_km, rider_min_per_delivery"/.test(rateGroup));
    check("the rate-card group is never written", !/rider_base_fee:|rider_per_km:/.test(rateGroup) && /write:\s*\(\)\s*(:[^=]+)?=>\s*\(\{\}\)/.test(rateGroup), rateGroup.slice(-200));
  }
  for (const file of ACTION_FILES) {
    let src = "";
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      check(`${file} exists`, false);
      continue;
    }
    check(`${file} is "use server"`, /^\s*"use server";/.test(src));
    const fns = exportedFunctions(src);
    check(`${file} exports server actions`, fns.length > 0);
    check(
      `${file} exports nothing but async functions and types`,
      !/export\s+(const|let|var|class|default)\b/.test(src) && !/export\s+function\b/.test(src)
    );
    for (const fn of fns) {
      const first = fn.body.replace(/\/\/.*$/gm, "").trim();
      check(`${file} ${fn.name}: first statement is requireRole("admin")`, /^(const\s+\w+\s*=\s*)?await\s+requireRole\(\s*"admin"\s*\)/.test(first), first.slice(0, 80));
      check(`${file} ${fn.name}: rate-limited`, /rateLimit\(/.test(fn.body) || /guard\(/.test(fn.body), fn.body.slice(0, 200));
    }
  }
}

// ---------------------------------------------------------------------------
// 3. the data layer, against an in-memory PostgREST
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-22T10:00:00+05:30");
const ADMIN = "00000000-0000-4000-8000-0000000000ad";
const R1 = "00000000-0000-4000-8000-000000000001"; // online, carrying an order, owed money
const R2 = "00000000-0000-4000-8000-000000000002"; // online but silent
const R3 = "00000000-0000-4000-8000-000000000003"; // never online
const CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
const orderId = (n: number) => `b${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

const db: Record<string, Row[]> = {};
const mode = { missingTables: new Set<string>() };
const requests: { method: string; table: string; query: string; body: Row | Row[] | null }[] = [];
const t = (name: string): Row[] => (db[name] ??= []);
let nextId = 1;
const reset = () => {
  for (const k of Object.keys(db)) delete db[k];
  mode.missingTables.clear();
  requests.length = 0;
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
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
      case "gte": hit = value != null && String(value) >= arg; break;
      case "lt": hit = value != null && String(value) < arg; break;
      default: throw new Error(`fake PostgREST: unsupported filter ${key}=${raw}`);
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}
function ordered(rows: Row[], url: URL): Row[] {
  const spec = url.searchParams.get("order");
  if (!spec) return rows;
  const keys = spec.split(",").map((k) => {
    const [col, dir] = k.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { col, sign } of keys) {
      if (a[col] === b[col]) continue;
      if (a[col] == null) return 1;
      if (b[col] == null) return -1;
      return (a[col] < b[col] ? -1 : 1) * sign;
    }
    return 0;
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const table = url.pathname.replace("/rest/v1/", "");
    const body: Row | Row[] | null = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method ?? "", table, query: url.search, body });
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(obj === null || obj === undefined ? "" : JSON.stringify(obj));
    };
    const single = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const respond = (rows: Row[], code = 200) => {
      if (!single) return send(code, rows);
      if (rows.length !== 1) return send(406, { code: "PGRST116", message: "0 rows" });
      return send(code, rows[0]);
    };
    if (table === "rpc/obs_ingest") return send(200, null);
    if (table.startsWith("rpc/")) return send(404, { code: "PGRST202", message: "Could not find the function" });
    if (mode.missingTables.has(table)) {
      return send(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const rows = ordered(t(table).filter((r) => matches(r, url)), url);
      if (req.method === "HEAD") return send(200, null, { "content-range": `*/${rows.length}` });
      const offset = Number(url.searchParams.get("offset")) || 0;
      const limit = Number(url.searchParams.get("limit"));
      return respond(rows.slice(offset, offset + (limit > 0 ? Math.min(limit, 1000) : 1000)));
    }
    if (req.method === "PATCH" && body && !Array.isArray(body)) {
      const hit = t(table).filter((r) => matches(r, url));
      for (const row of hit) Object.assign(row, body);
      return send(200, hit);
    }
    if (req.method === "POST" && body) {
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: `new-${nextId++}`, ...r }));
      t(table).push(...rows);
      return respond(rows, 201);
    }
    send(500, { code: "XX", message: `unhandled ${req.method} ${table}` });
  });
});

function earningRow(id: string, driver: string, amount: number, over: Row = {}): Row {
  return {
    id,
    delivery_id: `d-${id}`,
    order_id: orderId(1),
    driver_id: driver,
    earned_at: ist("2026-10-22", "09:00"),
    base_fee: amount,
    distance_km: 0,
    distance_source: null,
    billable_km: 0,
    distance_fee: 0,
    min_topup: 0,
    tip_amount: 0,
    tip_in_cash: false,
    amount,
    payout_id: null,
    ...over,
  };
}

function seedRiders(): void {
  t("profiles").push(
    { id: R1, role: "driver", full_name: "Asha Verma", phone: "+919800000001", created_at: "2026-09-01T00:00:00Z" },
    { id: R2, role: "driver", full_name: "Bharat Singh", phone: "+919800000002", created_at: "2026-09-02T00:00:00Z" },
    { id: R3, role: "driver", full_name: null, phone: null, created_at: "2026-09-03T00:00:00Z" },
    { id: CUSTOMER, role: "customer", full_name: "Not A Rider", phone: null, created_at: "2026-09-04T00:00:00Z" }
  );
  t("rider_profiles").push({ driver_id: R1, rider_code: "DR-0001" }, { driver_id: R2, rider_code: "DR-0002" });
  t("rider_status").push(
    { driver_id: R1, is_online: true, break_until: null, online_since: ist("2026-10-22", "08:00"), last_fix_at: ist("2026-10-22", "09:59") },
    { driver_id: R2, is_online: true, break_until: null, online_since: ist("2026-10-22", "06:00"), last_fix_at: ist("2026-10-22", "07:00") }
  );
  t("deliveries").push(
    { id: "d1", driver_id: R1, order_id: orderId(1), status: "delivered", delivered_at: ist("2026-10-22", "09:00") },
    { id: "d2", driver_id: R1, order_id: orderId(2), status: "delivered", delivered_at: ist("2026-10-22", "09:30") },
    { id: "d3", driver_id: R1, order_id: orderId(3), status: "picked_up", delivered_at: null },
    { id: "d4", driver_id: R2, order_id: orderId(4), status: "delivered", delivered_at: ist("2026-10-21", "20:00") }
  );
  t("rider_earnings").push(
    earningRow("e1", R1, 50),
    earningRow("e2", R1, 40, { order_id: orderId(2), earned_at: ist("2026-10-22", "09:30") }),
    earningRow("e3", R2, 25, { payout_id: "p-old", earned_at: ist("2026-10-20", "12:00") })
  );
  t("rider_incentive_awards").push({
    id: "a1",
    rule_id: "rule-1",
    driver_id: R1,
    period_start: "2026-10-22",
    amount: 100,
    trigger_earning_id: "e2",
    awarded_at: ist("2026-10-22", "09:30"),
    payout_id: null,
    notified_at: null,
  });
  t("rider_incentive_rules").push({
    id: "rule-1",
    name: "Two a day",
    period: "daily",
    target_deliveries: 2,
    bonus_amount: 100,
    window_start: null,
    window_end: null,
    starts_on: "2026-10-01",
    ends_on: null,
    active: true,
    created_at: "2026-10-01T00:00:00Z",
  });
  t("rider_adjustments").push({
    id: "j1",
    driver_id: R1,
    kind: "deduction",
    amount: 30,
    reason: "Damaged bag",
    order_id: null,
    effective_on: "2026-10-21",
    payout_id: null,
    reverses_earning_id: null,
    created_at: ist("2026-10-21", "10:00"),
  });
  t("rider_payouts").push({
    id: "p-old",
    driver_id: R2,
    period_end: "2026-10-20",
    amount: 25,
    method: "upi",
    reference: "UTR1",
    paid_on: "2026-10-21",
    note: null,
    created_at: ist("2026-10-21", "10:00"),
  });
  // p-old settled e3.
}

async function dataTier(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const a = await import("../../src/lib/data-access/admin-riders");
  const e = await import("../../src/lib/data-access/rider-earnings");
  const m = await import("../../src/lib/rider/admin-money");
  const { createAdminClient } = await import("../../src/lib/supabase/admin");
  const { isRiderSchemaPending } = await import("../../src/lib/data-access/rider-status");

  await group("listRidersForAdmin: riders only, with phase, order, today's count and what is owed", async () => {
    reset();
    seedRiders();
    const rows = await a.listRidersForAdmin(NOW);
    assert.deepEqual(rows.map((r) => r.id), [R1, R2, R3], "online first, then silent, then offline; the customer is not listed");
    const [r1, r2, r3] = rows;
    assert.equal(r1.name, "Asha Verma");
    assert.equal(r1.riderCode, "DR-0001");
    assert.equal(r1.phase, "online");
    assert.equal(r1.activeOrderCode, "#B0000003");
    assert.equal(r1.activeOrderId, orderId(3));
    assert.equal(r1.deliveredToday, 2);
    assert.equal(r1.pending, 160, "50 + 40 earned + 100 award - 30 deduction");
    assert.equal(r2.phase, "stale", "online, but the last position is hours old");
    assert.equal(r2.deliveredToday, 0, "yesterday's delivery is not today's");
    assert.equal(r2.pending, 0, "everything is paid");
    assert.equal(r3.phase, "offline");
    assert.equal(r3.name, null);
    assert.equal(r3.riderCode, null);
    assert.equal(r3.pending, 0);
    assert.equal(r3.activeOrderId, null);
  });
  await group("listRidersForAdmin: a rider on a break reads as on a break", async () => {
    reset();
    seedRiders();
    t("rider_status")[0].break_until = ist("2026-10-22", "10:30");
    const rows = await a.listRidersForAdmin(NOW);
    assert.equal(rows.find((r) => r.id === R1)?.phase, "break");
  });
  await group("listRidersForAdmin: before 0083 the owed figure is unknown, not ₹0", async () => {
    reset();
    seedRiders();
    for (const table of ["rider_earnings", "rider_incentive_awards", "rider_adjustments"]) mode.missingTables.add(table);
    const rows = await a.listRidersForAdmin(NOW);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.pending === null), "null, which the page shows as a dash");
  });
  await group("listRidersForAdmin: before 0081 nobody is online and no one has a code", async () => {
    reset();
    seedRiders();
    mode.missingTables.add("rider_status");
    mode.missingTables.add("rider_profiles");
    const rows = await a.listRidersForAdmin(NOW);
    assert.ok(rows.every((r) => r.phase === "offline" && r.riderCode === null));
  });

  await group("getRiderForAdmin: the Overview", async () => {
    reset();
    seedRiders();
    const r = await a.getRiderForAdmin(R1, NOW);
    assert.ok(r);
    assert.equal(r.phase, "online");
    assert.deepEqual(r.delivered, { today: 2, week: 2, total: 2 });
    assert.equal(r.activeOrderCode, "#B0000003");
    assert.equal(r.pending, 160);
    assert.equal(await a.getRiderForAdmin(CUSTOMER, NOW), null, "a customer is not a rider");
    assert.equal(await a.getRiderForAdmin("00000000-0000-4000-8000-0000000000ff", NOW), null);
    assert.equal(await a.riderExists(R1), true);
    assert.equal(await a.riderExists(CUSTOMER), false);
  });

  await group("getRiderMoney: summary, pending records, preview, payouts", async () => {
    reset();
    seedRiders();
    const money = await a.getRiderMoney(R1, {}, NOW);
    assert.equal(money.summary.pending, 160);
    assert.equal(money.pending.length, 4, "two deliveries, the award and the deduction");
    assert.deepEqual(money.range, { from: "2026-09-22", to: "2026-10-22" }, "the last 31 days");
    assert.equal(money.rangeFellBack, false);
    assert.deepEqual(money.preview("2026-10-22"), { amount: 160, items: 4, payable: true });
    assert.deepEqual(money.preview("2026-10-21"), { amount: -30, items: 1, payable: false }, "up to yesterday only the deduction");
    assert.equal(money.records.length, 4);
    assert.ok(money.records.every((r) => r.status === "pending"));
    assert.equal(money.payouts.length, 0, "another rider's payout is not listed");
    const other = await a.getRiderMoney(R2, {}, NOW);
    assert.equal(other.payouts.length, 1);
    assert.equal(other.payouts[0].items, 1);
    assert.equal(other.summary.pending, 0);
  });
  await group("getRiderMoney: ₹0 per-delivery rows are hidden from the records and the payout preview", async () => {
    reset();
    seedRiders();
    t("rider_earnings").push(
      earningRow("zero-1", R1, 0, { delivery_id: "d-zero-1", order_id: orderId(7) }),
      earningRow("zero-2", R1, 0, { delivery_id: "d-zero-2", order_id: orderId(8) })
    );
    const money = await a.getRiderMoney(R1, {}, NOW);
    assert.equal(money.records.length, 4, "the two ₹0 deliveries are not listed");
    assert.ok(money.records.every((r) => r.id !== "zero-1" && r.id !== "zero-2"));
    assert.deepEqual(money.preview("2026-10-22"), { amount: 160, items: 4, payable: true }, "...nor counted as items");
    assert.equal(money.summary.pending, 160, "they move no money");
  });
  await group("getRiderMoney: a bad range or cursor falls back instead of failing", async () => {
    reset();
    seedRiders();
    const badRange = await a.getRiderMoney(R1, { from: "2026-02-30", to: "2026-03-01" }, NOW);
    assert.equal(badRange.rangeFellBack, true);
    assert.deepEqual(badRange.range, { from: "2026-09-22", to: "2026-10-22" });
    const badCursor = await a.getRiderMoney(R1, { cursor: "zzz" }, NOW);
    assert.equal(badCursor.records.length, 4, "the list starts over");
    const half = await a.getRiderMoney(R1, { from: "2026-10-01" }, NOW);
    assert.equal(half.rangeFellBack, true, "a range needs both ends");
  });
  await group("getRiderMoney: before 0083 it is RiderSchemaPendingError (the page explains)", async () => {
    reset();
    seedRiders();
    mode.missingTables.add("rider_earnings");
    await assert.rejects(a.getRiderMoney(R1, {}, NOW), (err: unknown) => isRiderSchemaPending(err));
  });

  await group("insertAdjustment: created_by is the admin, the amount is stored as parsed", async () => {
    reset();
    seedRiders();
    const client = createAdminClient();
    const parsed = m.parseAdjustment(
      form({ kind: "deduction", amount: "75", reason: "Late return", effectiveOn: "2026-10-22", orderCode: "#B0000001" }),
      { today: "2026-10-22" }
    );
    assert.ok(parsed.ok);
    const orderFor = await a.resolveRiderOrder(R1, "B0000001");
    assert.equal(orderFor, orderId(1), "an order this rider delivered");
    assert.equal(await a.resolveRiderOrder(R1, "B0000004"), null, "another rider's order is refused");
    const out = await a.insertAdjustment(client, ADMIN, R1, parsed.value, orderFor);
    assert.ok(out.ok);
    const post = requests.find((r) => r.method === "POST" && r.table === "rider_adjustments");
    assert.deepEqual(post?.body, {
      driver_id: R1,
      kind: "deduction",
      amount: 75,
      reason: "Late return",
      order_id: orderId(1),
      effective_on: "2026-10-22",
      created_by: ADMIN,
    });
  });
  await group("insertAdjustment: a refusal comes back as a DbError, not a throw", async () => {
    reset();
    mode.missingTables.add("rider_adjustments");
    const out = await a.insertAdjustment(
      createAdminClient(),
      ADMIN,
      R1,
      { kind: "bonus", amount: 5, reason: "x", orderCode: null, effectiveOn: "2026-10-22" },
      null
    );
    assert.ok(!out.ok);
    assert.match(m.writeErrorMessage(out.error, "adjustment"), /set up/);
  });

  await group("describePayout: what was recorded, and why it can differ from the preview", () => {
    const recorded = { amount: 205, items: 4, paidOn: "2026-10-22", periodEnd: "2026-10-22" };
    const text = m.describePayout(recorded, "bank", 160);
    assert.match(text, /Recorded ₹205 paid by bank transfer on 22 Oct 2026 \(4 items up to 22 Oct 2026\)/);
    assert.match(text, /preview said ₹160/);
    assert.doesNotMatch(m.describePayout(recorded, "bank", 205), /preview said/, "no caveat when the preview was right");
  });

}

// ---------------------------------------------------------------------------
// 4. route contract (needs `npm run dev`)
// ---------------------------------------------------------------------------
const PAGES = ["/admin/riders", "/admin/riders/00000000-0000-4000-8000-0000000000aa", "/admin/riders/incentives"];

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

async function getPage(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

const turnedAway = (r: { status: number; location: string }) =>
  [301, 302, 303, 307, 308].includes(r.status) && /login|denied/.test(r.location);

async function contract(): Promise<void> {
  try {
    await fetch(`${BASE}/api/rider/me`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch {
    skip(`dev server unreachable at ${BASE} - start it with \`npm run dev\` (contract checks)`);
    return;
  }
  for (const page of PAGES) {
    const r = await getPage(page);
    check(`signed out is turned away  GET ${page}`, turnedAway(r), r);
  }
  if (!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD) {
    skip("non-admin checks: QA_CUSTOMER_EMAIL / QA_CUSTOMER_PASSWORD not set");
    return;
  }
  const cookie = await sessionCookie(CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
  for (const page of PAGES) {
    const r = await getPage(page, cookie);
    check(`a non-admin is turned away  GET ${page}`, turnedAway(r) && /denied=1/.test(r.location), r);
  }
}

async function main(): Promise<void> {
  console.log("-- 1. parsers, preview, messages");
  await pureTier();
  console.log("-- 2. server-action structure");
  await structureTier();
  console.log("-- 3. data layer (fake PostgREST)");
  await dataTier();
  console.log("-- 4. route contract");
  await contract();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
