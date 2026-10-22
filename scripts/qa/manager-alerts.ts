/**
 * QA — the alert evaluator (Phase 8, §14, §6.7–6.8).
 *
 * One case per kind proving it fires at its threshold and not one unit below,
 * a zone rule changing the outcome only in its zone, disabled kinds silent,
 * the Phase 9 kinds never emitted, stable dedupe keys, English-only text, the
 * catalog agreeing with migration 0166, and the sweep wired to the engine.
 *
 * Pure + file reads, no I/O. Usage: npx tsx scripts/qa/manager-alerts.ts
 */
import { readFileSync } from "node:fs";
import { ALERT_KINDS, effectiveRule, type ResolvedRule } from "../../src/lib/ops/alerts/catalog";
import { alertData, emptyFacts, evaluate, type AlertFacts, type DesiredAlert } from "../../src/lib/ops/alerts/evaluate";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-10-22T08:00:00.000Z"); // 13:30 IST
const ZA = "zone-a";
const ZB = "zone-b";
const defaults: ResolvedRule[] = ALERT_KINDS.map((k) => ({
  kind: k.kind, zoneId: null, enabled: k.evaluated !== "phase9", threshold: k.defaultThreshold, windowMinutes: k.defaultWindowMinutes,
}));
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const facts = (patch: Partial<AlertFacts>): AlertFacts => ({ ...emptyFacts(NOW), zones: [{ id: ZA, name: "Bemetara" }, { id: ZB, name: "Saja" }], ...patch });
const run = (f: AlertFacts, rules = defaults) => evaluate(f, rules);
const of = (m: Map<string, DesiredAlert[]>, kind: string) => m.get(kind) ?? [];
const sev = (m: Map<string, DesiredAlert[]>, kind: string) => of(m, kind).map((a) => a.severity).join(",");

const order = (id: string, p: Partial<AlertFacts["orders"][number]> = {}): AlertFacts["orders"][number] => ({
  id, code: id.toUpperCase().slice(0, 8), zoneId: ZA, status: "ready", vendorName: "Spice Hub", createdAt: ago(20), lastChangeAt: ago(5),
  acceptWaitMinutes: null, unassignedMinutes: null, lateByMinutes: null, hasRider: false, ...p,
});

console.log("\n── orders ──");
let m = run(facts({ orders: [order("o1", { unassignedMinutes: 4 })] }));
check("unassigned 4 min → nothing", of(m, "order_unassigned").length === 0);
m = run(facts({ orders: [order("o1", { unassignedMinutes: 5 })] }));
check("unassigned 5 min → warning", sev(m, "order_unassigned") === "warning", sev(m, "order_unassigned"));
m = run(facts({ orders: [order("o1", { unassignedMinutes: 15 })] }));
check("unassigned 15 min → critical", sev(m, "order_unassigned") === "critical");
check("...keyed by the order", of(m, "order_unassigned")[0]?.dedupeKey === "order_unassigned:o1");
check("...titled with the order code and the shop", /O1/.test(of(m, "order_unassigned")[0]?.title ?? "") && /Spice Hub/.test(of(m, "order_unassigned")[0]?.body ?? ""));
m = run(facts({ orders: [order("o2", { status: "placed", acceptWaitMinutes: 4 })] }));
check("kitchen not accepting 4 min → nothing", of(m, "order_needs_intervention").length === 0);
m = run(facts({ orders: [order("o2", { status: "placed", acceptWaitMinutes: 5 })] }));
check("kitchen not accepting 5 min → warning", sev(m, "order_needs_intervention") === "warning");
m = run(facts({ exceptionsPending: [{ id: "x1", orderId: "o3", orderCode: "O3", zoneId: ZA, kindLabel: "Customer unreachable", createdAt: ago(6) }] }));
check("a rider's request waiting 6 min → intervention", of(m, "order_needs_intervention")[0]?.dedupeKey === "order_needs_intervention:exception:x1");
m = run(facts({ orders: [order("o4", { status: "kitchen", lastChangeAt: ago(181) })] }));
check("an order unmoved for over three hours → stuck", of(m, "order_needs_intervention").some((a) => a.dedupeKey === "order_needs_intervention:stuck:o4"));
m = run(facts({ orders: [order("o5", { lateByMinutes: 9, hasRider: true, status: "on_the_way" })] }));
check("late 9 min → nothing", of(m, "delivery_delayed").length === 0);
m = run(facts({ orders: [order("o5", { lateByMinutes: 10, hasRider: true, status: "on_the_way" })] }));
check("late 10 min → warning", sev(m, "delivery_delayed") === "warning");

console.log("\n── cancellations ──");
const recent = (zone: string, placed: number, cancelled: number, minutesAgo = 10) =>
  Array.from({ length: placed }, (_, i) => ({ zoneId: zone, status: i < cancelled ? "cancelled" : "delivered", createdAt: ago(minutesAgo) }));
m = run(facts({ recentOrders: recent(ZA, 4, 1) }));
check("1 of 4 cancelled → nothing (fewer than 5 placed)", of(m, "high_cancellation_rate").length === 0);
m = run(facts({ recentOrders: recent(ZA, 8, 2) }));
check("2 of 8 (25 %) → warning", sev(m, "high_cancellation_rate") === "warning");
m = run(facts({ recentOrders: recent(ZA, 8, 4) }));
check("4 of 8 (50 %) → critical", sev(m, "high_cancellation_rate") === "critical");
m = run(facts({ recentOrders: recent(ZA, 8, 4, 90) }));
check("outside the 60-minute window → nothing", of(m, "high_cancellation_rate").length === 0);

console.log("\n── vendors ──");
const shop = (p: Partial<AlertFacts["vendors"][number]> = {}): AlertFacts["vendors"][number] => ({
  id: "r1", name: "Spice Hub", zoneId: ZA, scheduledOpen: true, closed: true, closedMinutes: 30, troubledOrderTimes: [], ...p,
});
m = run(facts({ vendors: [shop({ closedMinutes: 29 })] }));
check("closed 29 min in hours → nothing", of(m, "vendor_downtime").length === 0);
m = run(facts({ vendors: [shop()] }));
check("closed 30 min in hours → downtime", of(m, "vendor_downtime").length === 1);
check("...keyed by shop and IST date", of(m, "vendor_downtime")[0]?.dedupeKey === "vendor_downtime:r1:2026-10-22");
m = run(facts({ vendors: [shop({ scheduledOpen: false, closedMinutes: 300 })] }));
check("closed outside its hours → nothing", of(m, "vendor_downtime").length === 0);
m = run(facts({ vendors: [shop({ closed: false, closedMinutes: null, troubledOrderTimes: [ago(10), ago(20)] })] }));
check("two orders left unaccepted in the window → downtime", of(m, "vendor_downtime").length === 1);

console.log("\n── riders ──");
const rider = (id: string, p: Partial<AlertFacts["riders"][number]> = {}): AlertFacts["riders"][number] => ({
  id, zoneIds: [ZA], online: true, onBreak: false, activeDeliveries: 0, ...p,
});
const waiting = (n: number) => Array.from({ length: n }, (_, i) => order(`w${i}`, { unassignedMinutes: 0 }));
m = run(facts({ orders: waiting(4), riders: [rider("d1"), rider("d2")] }));
check("4 waiting / 2 idle riders → shortage", sev(m, "rider_shortage") === "warning", sev(m, "rider_shortage"));
m = run(facts({ orders: waiting(3), riders: [rider("d1"), rider("d2")] }));
check("3 waiting / 2 idle (ratio 1.5) → nothing", of(m, "rider_shortage").length === 0);
m = run(facts({ orders: waiting(1), riders: [] }));
check("no rider online with an active order → critical", sev(m, "rider_shortage") === "critical");
m = run(facts({ inactive: [{ riderId: "d1", riderName: "Ravi", orderId: "o1", orderCode: "O1", zoneId: ZA, minutes: 6 }] }));
check("no fix for 6 min on an active delivery → inactive", of(m, "rider_inactive")[0]?.dedupeKey === "rider_inactive:d1:o1");
m = run(facts({ inactive: [{ riderId: "d1", riderName: "Ravi", orderId: "o1", orderCode: "O1", zoneId: ZA, minutes: 4 }] }));
check("4 min → nothing", of(m, "rider_inactive").length === 0);
m = run(facts({ failed: [{ deliveryId: "dl1", orderId: "o1", orderCode: "O1", zoneId: ZA, vendorName: "Spice Hub", riderName: "Ravi" }] }));
check("a failed delivery → critical", sev(m, "delivery_failed") === "critical" && of(m, "delivery_failed")[0].dedupeKey === "delivery_failed:dl1");

console.log("\n── money ──");
const issue = (type: string, p = {}) => ({ zoneId: ZA, type, severity: "warning" as const, subjectKind: "vendor", subjectId: "r1", subjectLabel: "Spice Hub", detail: null, amount: 1200, since: ago(60 * 24 * 12), ...p });
m = run(facts({ financeIssues: [issue("settlement_delayed")] }));
check("a late settlement → settlement_delayed", of(m, "settlement_delayed")[0]?.dedupeKey === "settlement_delayed:r1");
m = run(facts({ financeIssues: [issue("approval_overdue", { subjectKind: "payment_request", subjectId: "pr1", subjectLabel: "Rider payout" })] }));
check("an overdue rider payout approval → rider_payout_issue", of(m, "rider_payout_issue")[0]?.dedupeKey === "rider_payout_issue:req:pr1");
m = run(facts({ financeIssues: [issue("approval_overdue", { subjectKind: "payment_request", subjectId: "pr2", subjectLabel: "Vendor settlement" })] }));
check("an overdue settlement approval → settlement_delayed", of(m, "settlement_delayed")[0]?.dedupeKey === "settlement_delayed:req:pr2");
m = run(facts({ financeIssues: [issue("rider_payout_delayed", { subjectKind: "rider", subjectId: "d1", subjectLabel: "Ravi" })] }));
check("an unpaid rider → rider_payout_issue", of(m, "rider_payout_issue")[0]?.dedupeKey === "rider_payout_issue:d1");
m = run(facts({ financeIssues: [issue("failed_payment")] }));
check("other finance issues raise no alert", of(m, "settlement_delayed").length === 0 && of(m, "rider_payout_issue").length === 0);
const cash = (p: Partial<AlertFacts["cashDays"][number]> = {}): AlertFacts["cashDays"][number] => ({
  zoneId: ZA, riderId: "d1", riderName: "Ravi", day: "2026-10-21", collected: 1500, deposited: 1001, disputed: false, hoursSinceDayEnd: 13, ...p,
});
m = run(facts({ cashDays: [cash()] }));
check("cash gap ₹499 → nothing", of(m, "cash_discrepancy").length === 0);
m = run(facts({ cashDays: [cash({ deposited: 1000 })] }));
check("cash gap ₹500 after 13 h → warning", sev(m, "cash_discrepancy") === "warning");
m = run(facts({ cashDays: [cash({ deposited: 1000, hoursSinceDayEnd: 11 })] }));
check("...not before the 12-hour window", of(m, "cash_discrepancy").length === 0);
m = run(facts({ cashDays: [cash({ deposited: 1500, disputed: true, hoursSinceDayEnd: 1 })] }));
check("a disputed day → critical", sev(m, "cash_discrepancy") === "critical");
check("...keyed by rider and day", of(m, "cash_discrepancy")[0]?.dedupeKey === "cash_discrepancy:d1:2026-10-21");

console.log("\n── tickets, marketing, incidents ──");
const ticket = (p: Partial<AlertFacts["tickets"][number]> = {}): AlertFacts["tickets"][number] => ({
  id: "t1", number: 41, subject: "Cold food", zoneId: ZA, priority: "normal", status: "open", createdAt: ago(10), firstResponseAt: null, ...p,
});
m = run(facts({ tickets: [ticket()] }));
check("a normal ticket unanswered 10 min → nothing", of(m, "complaint_high_priority").length === 0);
m = run(facts({ tickets: [ticket({ createdAt: ago(31) })] }));
check("any ticket unanswered 31 min → warning", sev(m, "complaint_high_priority") === "warning");
m = run(facts({ tickets: [ticket({ priority: "emergency", firstResponseAt: ago(5) })] }));
check("an open emergency ticket → critical", sev(m, "complaint_high_priority") === "critical");
m = run(facts({ tickets: [ticket({ priority: "high", status: "resolved" })] }));
check("a resolved high ticket → nothing", of(m, "complaint_high_priority").length === 0);
m = run(facts({ marketingPending: [{ id: "mr1", number: 7, zoneId: ZA, title: "Diwali banner", vendorName: "Spice Hub" }] }));
check("a pending marketing request → info", sev(m, "marketing_request_new") === "info");
m = run(facts({ incidents: [{ id: 9, shortId: "INC-9", title: "Checkout errors", severity: "high" }] }));
check("an open high incident → critical, platform-wide",
  sev(m, "incident") === "critical" && of(m, "incident")[0].zoneId === null && of(m, "incident")[0].dedupeKey === "incident:obs:9");

console.log("\n── rules ──");
const zoneRule: ResolvedRule[] = [...defaults, { kind: "order_unassigned", zoneId: ZB, enabled: true, threshold: 10, windowMinutes: null }];
m = run(facts({ orders: [order("a1", { unassignedMinutes: 6 }), order("b1", { zoneId: ZB, unassignedMinutes: 6 })] }), zoneRule);
check("a zone rule changes the outcome only in its zone", of(m, "order_unassigned").map((a) => a.entity.id).join(",") === "a1");
const off: ResolvedRule[] = [...defaults, { kind: "order_unassigned", zoneId: ZA, enabled: false, threshold: 5, windowMinutes: null }];
m = run(facts({ orders: [order("a1", { unassignedMinutes: 30 })] }), off);
check("a disabled kind raises nothing in that zone", of(m, "order_unassigned").length === 0);
check("effective rule falls back to the default", effectiveRule(defaults, "order_unassigned", ZA).threshold === 5);
m = run(facts({ orders: [order("o1", { unassignedMinutes: 15 })], tickets: [ticket({ priority: "emergency" })] }));
check("fraud and SLA are never emitted", !m.has("fraud_suspected") && !m.has("sla_breach"));
const again = run(facts({ orders: [order("o1", { unassignedMinutes: 15 })], tickets: [ticket({ priority: "emergency" })] }));
const keys = (x: Map<string, DesiredAlert[]>) => [...x.values()].flat().map((a) => a.dedupeKey).sort().join("|");
check("dedupe keys are stable across evaluations", keys(m) === keys(again));
const everything = run(facts({
  orders: [order("o1", { unassignedMinutes: 15, lateByMinutes: 40 }), order("o2", { status: "placed", acceptWaitMinutes: 20 })],
  vendors: [shop()], riders: [], failed: [{ deliveryId: "dl1", orderId: "o1", orderCode: "O1", zoneId: ZA, vendorName: "Spice Hub", riderName: "Ravi" }],
  tickets: [ticket({ priority: "emergency" })], cashDays: [cash({ disputed: true })],
  marketingPending: [{ id: "mr1", number: 7, zoneId: ZA, title: "Diwali banner", vendorName: "Spice Hub" }],
}));
const text = [...everything.values()].flat().map((a) => a.title + " " + a.body).join(" ");
check("alert text is English only (no Devanagari)", text.length > 0 && !/[ऀ-ॿ]/.test(text));

console.log("\n── link data ──");
const data = (x: Map<string, DesiredAlert[]>, kind: string) => alertData(of(x, kind)[0]);
m = run(facts({ marketingPending: [{ id: "mr1", number: 7, zoneId: ZA, title: "Diwali banner", vendorName: "Spice Hub" }] }));
check("a marketing alert carries requestId", data(m, "marketing_request_new").requestId === "mr1");
m = run(facts({ cashDays: [cash({ disputed: true })] }));
check("a cash alert carries riderId and day", data(m, "cash_discrepancy").riderId === "d1" && data(m, "cash_discrepancy").day === "2026-10-21");
m = run(facts({ failed: [{ deliveryId: "dl1", orderId: "o1", orderCode: "O1", zoneId: ZA, vendorName: "Spice Hub", riderName: "Ravi" }] }));
check("a failed-delivery alert carries orderId", data(m, "delivery_failed").orderId === "o1");
m = run(facts({ inactive: [{ riderId: "d1", riderName: "Ravi", orderId: "o1", orderCode: "O1", zoneId: ZA, minutes: 6 }] }));
check("a quiet-rider alert carries orderId and riderId", data(m, "rider_inactive").orderId === "o1" && data(m, "rider_inactive").riderId === "d1");
m = run(facts({ orders: [order("o5", { lateByMinutes: 12, hasRider: true, status: "on_the_way" })] }));
check("a late-delivery alert carries orderId", data(m, "delivery_delayed").orderId === "o5");

console.log("\n── catalog ↔ migration ──");
const sql = readFileSync("supabase/migrations/0166_ops_alerts.sql", "utf8");
for (const k of ALERT_KINDS) {
  const seed = new RegExp(`\\('${k.kind}',\\s*null,\\s*(true|false),\\s*([0-9.]+|null),\\s*([0-9]+|null)\\)`).exec(sql);
  const t = seed ? (seed[2] === "null" ? null : Number(seed[2])) : undefined;
  const w = seed ? (seed[3] === "null" ? null : Number(seed[3])) : undefined;
  check(`${k.kind}: seeded with the catalog default`, !!seed && t === k.defaultThreshold && w === k.defaultWindowMinutes
    && (seed[1] === "true") === (k.evaluated !== "phase9"), seed?.[0]);
}

console.log("\n── structure ──");
const sweep = readFileSync("src/lib/dispatch/sweep.ts", "utf8");
check("the sweep no longer sends the old kitchen / no-rider / stuck pushes",
  !/notifyOpsKitchenSlow|notifyOpsNoRider|notifyOpsStuck/.test(sweep));
check("the sweep runs the alert engine", /evaluateAlerts\(/.test(sweep));
check("the vendor re-ring stays", /notifyVendorStillWaiting/.test(sweep));
for (const [file, what] of [
  ["src/lib/data-access/marketing.ts", "a new marketing request"],
  ["src/lib/data-access/support.ts", "a high-priority ticket"],
  ["src/lib/data-access/delivery-exceptions.ts", "a failed delivery"],
  ["src/lib/data-access/rider-cash.ts", "a cash dispute"],
] as const) {
  check(`${what} raises its alert at once (${file})`, /raiseEventAlert\(/.test(readFileSync(file, "utf8")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
