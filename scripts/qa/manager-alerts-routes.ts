/**
 * QA — the Alerts, thresholds, inbox and audit-log endpoints (Phase 8, §14–§16).
 *
 * Pure: the audience filter (finance kinds need finance.view; platform-wide
 * alerts are incidents only for managers), action and incident bodies, the
 * threshold bounds per unit, audit query parsing, redaction and the diff.
 * Structural: every route opens with managerApiContext (the audit ones with
 * manager.audit.view_zone, rule writes with manager.alerts.configure), every
 * write is rate-limited and goes through its ops_* RPC, the prefs route
 * refuses to mute a locked kind, the admin pages follow the console rules.
 *
 * Usage: npx tsx scripts/qa/manager-alerts-routes.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  alertVisible,
  auditDiff,
  decodeCursor,
  encodeCursor,
  parseAlertAction,
  parseAlertQuery,
  parseAuditQuery,
  parseIncident,
  parseRuleBody,
  redactAuditPayload,
  visibleKinds,
} from "../../src/lib/ops/alerts-contract";
import { AUDIT_ACTIONS } from "../../src/lib/ops/audit-catalog";

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
const CID = "3f1c6a52-7d7f-4f0e-9d8c-2a1f0b6c9e11";
const Z = "11111111-2222-4333-8444-555555555555";

console.log("\n── audience ──");
const plain = { admin: false, permissions: { "manager.support.manage": true } as Record<string, boolean> };
const fin = { admin: false, permissions: { "manager.finance.view": true, "manager.support.manage": true } as Record<string, boolean> };
check("a manager without finance.view sees no finance kinds",
  !alertVisible({ kind: "settlement_delayed", zoneId: Z }, plain) && !visibleKinds(plain).includes("cash_discrepancy"));
check("...with it, they do", alertVisible({ kind: "settlement_delayed", zoneId: Z }, fin) && visibleKinds(fin).includes("rider_payout_issue"));
check("a platform-wide shortage is hidden from managers", !alertVisible({ kind: "rider_shortage", zoneId: null }, fin));
check("a platform-wide incident is shown", alertVisible({ kind: "incident", zoneId: null }, plain));
check("marketing needs marketing.manage", !alertVisible({ kind: "marketing_request_new", zoneId: Z }, plain));
check("an admin sees everything", alertVisible({ kind: "settlement_delayed", zoneId: null }, { admin: true, permissions: {} }));

console.log("\n── bodies and queries ──");
const res = parseAlertAction({ action: "resolve", clientActionId: CID });
check("resolve without a note → reason_required", !res.ok && res.error === "reason_required");
check("acknowledge needs no note", parseAlertAction({ action: "acknowledge", clientActionId: CID }).ok);
check("an unknown action → bad_request", !parseAlertAction({ action: "snooze", clientActionId: CID }).ok);
check("an incident needs a zone", !parseIncident({ title: "Down", body: "Payments failing", severity: "critical", clientActionId: CID }).ok);
check("an incident's severity is warning or critical", !parseIncident({ title: "Down", body: "Payments failing", severity: "info", zoneId: Z, clientActionId: CID }).ok);
check("alert status defaults to open and acknowledged", (() => { const q = parseAlertQuery(new URLSearchParams()); return !("error" in q) && q.statuses.join() === "open,acknowledged"; })());
check("an unknown alert kind → field kind", (() => { const q = parseAlertQuery(new URLSearchParams("kind=late")); return "error" in q && q.field === "kind"; })());

console.log("\n── threshold bounds ──");
const rule = (kind: string, threshold: unknown, windowMinutes: unknown = null) =>
  parseRuleBody({ kind, zoneId: Z, enabled: true, threshold, windowMinutes, clientActionId: CID });
const badThreshold = (r: ReturnType<typeof rule>) => !r.ok && r.error === "bad_threshold";
check("minutes 0 → bad_threshold", badThreshold(rule("order_unassigned", 0)));
check("minutes 1441 → bad_threshold", badThreshold(rule("order_unassigned", 1441)));
check("minutes 7 → ok", rule("order_unassigned", 7).ok);
check("percent 101 → bad_threshold", badThreshold(rule("high_cancellation_rate", 101, 60)));
check("ratio 0.4 → bad_threshold", badThreshold(rule("rider_shortage", 0.4)));
check("rupees 49 → bad_threshold", badThreshold(rule("cash_discrepancy", 49, 720)));
check("a window of 3 min → bad_threshold", badThreshold(rule("high_cancellation_rate", 20, 3)));
check("a window of a week (10080) → ok", rule("high_cancellation_rate", 20, 10080).ok);
check("a window of 10081 → bad_threshold", badThreshold(rule("high_cancellation_rate", 20, 10081)));
check("a kind without a threshold refuses one", badThreshold(rule("delivery_failed", 5)));
check("...and accepts none", rule("delivery_failed", null).ok);
check("the platform default is a null zone", (() => { const r = parseRuleBody({ kind: "order_unassigned", zoneId: null, enabled: true, threshold: 5, windowMinutes: null, clientActionId: CID }); return r.ok && r.value.zoneId === null; })());

console.log("\n── audit ──");
const aq = parseAuditQuery(new URLSearchParams("action=order.*"));
check("a prefix filter", !("error" in aq) && aq.actions?.length === 1 && "prefix" in aq.actions[0] && aq.actions[0].prefix === "order.");
const ex = parseAuditQuery(new URLSearchParams("action=delivery.reassign"));
check("an exact filter", !("error" in ex) && !!ex.actions && "exact" in ex.actions[0]);
const area = parseAuditQuery(new URLSearchParams("actions=order.*,delivery.*,ticket.assign"));
check("actions= takes a comma list of prefixes and codes", !("error" in area) && area.actions?.length === 3);
check("a malformed action → field action", (() => { const q = parseAuditQuery(new URLSearchParams("action=DROP TABLE")); return "error" in q && q.field === "action"; })());
const red = redactAuditPayload({ status: "x", customer: { phone: "9999999999", address: "12 Road", name: "Asha" }, bank: { accountNumber: "1234", ifsc: "SBIN" }, upiId: "a@b" }) as Record<string, Record<string, unknown>>;
check("nested phone and address are redacted", red.customer.phone === "[redacted]" && red.customer.address === "[redacted]" && red.customer.name === "Asha");
check("a bank object and a UPI id are redacted whole", (red as unknown as Record<string, unknown>).bank === "[redacted]" && (red as unknown as Record<string, unknown>).upiId === "[redacted]");
const r2 = redactAuditPayload({ account: "active", accountNumber: "1234567890123", ifsc: "SBIN0001", licenceNumber: "CG0420180012345", drivingLicense: "x", aadharNo: "1111", authToken: "abc", password: "p", otp: "123456", vehicleNumber: "CG 24 AB 1234", panNumber: "ABCDE1234F" }) as Record<string, unknown>;
check("a rider's account status ({account:'active'}) survives — it is not a bank account (review #9)", r2.account === "active");
check("licence, driving licence, aadhaar, token, password, otp, vehicle and PAN keys are redacted",
  ["accountNumber", "ifsc", "licenceNumber", "drivingLicense", "aadharNo", "authToken", "password", "otp", "vehicleNumber", "panNumber"].every((k) => r2[k] === "[redacted]"),
  JSON.stringify(r2));
const free = redactAuditPayload({ note: "Behind the temple, call 9876543210", other: "reach me on asha@example.com", fine: "Rider found the shop", at: "2026-10-21T08:00:00+00:00" }) as Record<string, unknown>;
check("free text carrying a phone number or an email is redacted by its value", free.note === "[redacted]" && free.other === "[redacted]");
check("...ordinary text and timestamps are not", free.fine === "Rider found the shop" && free.at === "2026-10-21T08:00:00+00:00");
const addr = redactAuditPayload({ note: "Gate 3, blue house" }, "order.correct.address_note") as Record<string, unknown>;
check("a drop-off address note is redacted whole for that correction (it is the customer's address)", addr.note === "[redacted]");
const resolved = redactAuditPayload({ note: "Rider found" }, "alert.resolve") as Record<string, unknown>;
check("...but a note on another action is not", resolved.note === "Rider found");
const diff = auditDiff({ status: "ready", x: { y: 1 }, same: 3 }, { status: "kitchen", x: { y: 2 }, same: 3 });
check("the diff lists the two changed leaves as dotted paths", diff.length === 2 && diff[0].path === "status" && diff[1].path === "x.y");
const UUID = "3f1c6a52-7d7f-4f0e-9d8c-2a1f0b6c9e11";
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64url");
check("a real cursor round-trips", decodeCursor(encodeCursor({ at: "2026-10-21T08:00:00.123456+00:00", id: UUID }))?.id === UUID);
for (const bad of ["2026-10-21 (a,b)", "2026-10-21T08:00:00Z,id.gt.0", "2026-10-21", "now()", "2026-10-21T08:00:00Z)"]) {
  check(`a cursor time that is not exactly a timestamp is refused: ${JSON.stringify(bad)} (review #18)`, decodeCursor(b64(`${bad}|${UUID}`)) === null);
}
check("...so a list asked with one answers bad_request (field cursor)",
  (() => { const q = parseAuditQuery(new URLSearchParams(`cursor=${b64(`2026-10-21 (a,b)|${UUID}`)}`)); return "error" in q && q.field === "cursor"; })());
check("the audit catalog has no duplicate codes", new Set(AUDIT_ACTIONS.map((a) => a.code)).size === AUDIT_ACTIONS.length);

console.log("\n── structure ──");
const routes: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f === "route.ts") routes.push(p.replace(/\\/g, "/"));
  }
};
for (const d of ["alerts", "alert-rules", "notifications", "audit"]) walk(`src/app/api/manager/${d}`);
check("eleven routes", routes.length === 11, String(routes.length));
for (const f of routes) {
  const src = readFileSync(f, "utf8");
  check(`${f} opens with managerApiContext`, /managerApiContext\(/.test(src));
  if (/export async function (POST|PUT|DELETE)/.test(src)) check(`${f} rate-limits its writes`, /managerWriteLimit\(/.test(src));
  if (f.includes("/audit")) check(`${f} needs manager.audit.view_zone`, /managerApiContext\("manager\.audit\.view_zone"\)/.test(src));
}
const rules = readFileSync("src/app/api/manager/alert-rules/route.ts", "utf8");
check("rule writes need manager.alerts.configure", (rules.match(/managerApiContext\("manager\.alerts\.configure"\)/g) ?? []).length === 2);
const alertsData = readFileSync("src/lib/data-access/manager-alerts.ts", "utf8");
for (const rpc of ["ops_ack_alert", "ops_resolve_alert", "ops_raise_incident", "ops_set_alert_rule", "ops_reset_alert_rule"]) {
  check(`alerts data layer calls ${rpc}`, alertsData.includes(`"${rpc}"`));
}
check("the alerts data layer never writes alert tables directly", !/\.from\("ops_alert(s|_rules|_events)"\)\s*\.(insert|update|upsert|delete)/.test(alertsData));
check("a manager cannot set the platform default", /zoneId === null && actor\.role !== "admin"/.test(alertsData));
const prefs = readFileSync("src/app/api/manager/notification-prefs/route.ts", "utf8");
check("prefs refuse to mute a locked kind (not_mutable)", /not_mutable/.test(prefs) && /LOCKED_KINDS/.test(prefs));
const inbox = readFileSync("src/lib/data-access/manager-inbox.ts", "utf8");
check("the inbox only ever touches the caller's rows", (inbox.match(/\.eq\("user_id", userId\)/g) ?? []).length >= 3);
for (const page of ["src/app/admin/alerts/page.tsx", "src/app/admin/settings/alerts/page.tsx", "src/app/admin/audit/page.tsx"]) {
  const src = readFileSync(page, "utf8");
  check(`${page} is admin-gated`, /await requireRole\("admin"\)/.test(src));
  check(`${page} has no phone chrome, viewport breakpoints or dark: variants`, !/\.device|StatusBar|\bmd:|\blg:|dark:/.test(src));
}
const actions = readFileSync("src/app/admin/alerts/actions.ts", "utf8");
check("admin alert actions start with the admin gate and a rate limit", /requireRole\("admin"\)/.test(actions) && /rateLimit\(/.test(actions));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
