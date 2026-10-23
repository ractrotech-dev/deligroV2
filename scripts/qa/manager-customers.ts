/**
 * QA — Phase 7 customers: the contract (query and body parsing, display
 * name, locality, masked phone, what a manager may do), personal-data walk
 * tests on every customer payload, and the structure of the routes and of
 * suspension enforcement at sign-in and checkout. Pure and structural.
 *
 * Usage:  npm run test:manager-customers
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  customerAllowed, displayName, localityOf, parseAccountActionBody, parseContactBody, parseCustomerQuery, phoneE164,
  serializeCustomer, type CustomerDetail,
} from "../../src/lib/ops/customer-contract";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const field = (r: { ok: boolean; field?: string }) => (r.ok ? null : r.field);
const q = (s: string) => parseCustomerQuery(new URLSearchParams(s));

console.log("\n── queries ──");
check("q may be a uuid, a hex prefix or a name", q(`q=${U(7)}`).ok && q("q=a1b2c3d4").ok && q("q=Priya").ok);
check("a one-letter q → q", field(q("q=P")) === "q");
check("a 9-digit phone → phone", field(q("phone=987654321")) === "phone");
check("a 10-digit phone becomes +91", (() => { const r = q("phone=9876543210"); return r.ok && r.q.phone === "+919876543210"; })());
check("bad status / sort / zone are named", field(q("status=banned")) === "status" && field(q("sort=name")) === "sort" && field(q("zone=x")) === "zone");
check("phoneE164 keeps only Indian 10-digit numbers", phoneE164("+919876543210") === "+919876543210" && phoneE164("12345") === null);

console.log("\n── bodies ──");
check("contact without a reason → reason_required", (() => { const r = parseContactBody({ clientActionId: "abcdefgh" }); return !r.ok && r.error === "reason_required"; })());
check("contact 'other' needs a note", (() => { const r = parseContactBody({ reason: "other", clientActionId: "abcdefgh" }); return !r.ok && r.field === "note"; })());
check("contact with a listed reason", parseContactBody({ reason: "refund", clientActionId: "abcdefgh" }).ok);
check("suspend without a reason → reason_required", (() => {
  const r = parseAccountActionBody({ action: "suspend", expected: "active", reason: "", clientActionId: "abcdefgh" });
  return !r.ok && r.error === "reason_required";
})());
check("an unknown expected status → expected", field(parseAccountActionBody({ action: "suspend", expected: "banned", reason: "Fraud ring", clientActionId: "abcdefgh" })) === "expected");

console.log("\n── shapes and personal data ──");
check("display name: first name and last initial", displayName("Priya  Sharma") === "Priya S." && displayName("Asha") === "Asha" && displayName("  ") === null);
check("locality: the last two parts of the line", localityOf("12 Gali, Station Road, Bemetara") === "Station Road, Bemetara");
const summary = serializeCustomer({ id: U(1), full_name: "Priya Sharma", phone: "+919876543210", account_status: "restricted",
  member_since: "2026-01-01T00:00:00Z", orders: 4, spent: 1200, last_order_at: null, zone_ids: [U(9)], sort_key: "1" }, () => "Bemetara");
check("summary: masked phone, display name, short id, status", summary.phoneMasked === "••••••3210" && summary.name === "Priya S."
  && summary.shortId === "00000000" && summary.status === "restricted");
const walk = (v: unknown, path = ""): string[] => (v && typeof v === "object"
  ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${path}.${k}`, ...walk(x, `${path}.${k}`)]) : []);
const PII = /phone$|email|address_line|\.lat$|\.lng$/i;
check("summary carries no phone, email, address or position key", !walk(summary).some((k) => PII.test(k)), walk(summary));
check("...and no unmasked number anywhere", !JSON.stringify(summary).includes("9876543210"));
const detail: CustomerDetail = { ...summary, statusReason: null, statusChangedAt: null, statusChangedBy: null, localities: ["Station Road, Bemetara"],
  cancelledOrders: 0, aov: 300, firstOrderAt: null, ratingsGiven: 0, avgRatingGiven: null, openComplaints: 0, pendingRefunds: 0,
  allowed: customerAllowed("restricted", {}) };
check("detail carries no personal-data key either", !walk(detail).some((k) => PII.test(k)));

console.log("\n── permissions ──");
const none = customerAllowed("active", {});
check("no switches → nothing allowed", Object.values(none).every((v) => v === false));
const all = customerAllowed("suspended", { "manager.customers.contact": true, "manager.customers.suspend": true,
  "manager.finance.view": true, "manager.finance.adjust": true });
check("a suspended customer: reactivate and restrict offered, not suspend again", all.reactivate && all.restrict && !all.suspend && all.revealContact && all.decideRefunds);

console.log("\n── routes (structure) ──");
const root = join(__dirname, "../../src/app/api/manager/customers");
const files: string[] = [];
const walkDir = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDir(p); else if (f === "route.ts") files.push(p); } };
walkDir(root);
check("eight customer route files", files.length === 8, files.length);
for (const f of files) {
  const src = readFileSync(f, "utf8");
  check(`${f.slice(root.length)}: opens with managerApiContext("manager.customers.view")`, src.includes('managerApiContext("manager.customers.view")'));
  check(`${f.slice(root.length)}: no select("*")`, !/select\("\*"\)/.test(src));
}
const list = readFileSync(join(root, "route.ts"), "utf8");
check("phone search checks customers.contact before searching, and is rate-limited",
  list.indexOf('"manager.customers.contact"') > -1 && list.indexOf('"manager.customers.contact"') < list.indexOf("searchCustomersByPhone(")
  && list.includes("managerWriteLimit("));
for (const [f, perm] of [["[id]/contact/route.ts", "manager.customers.contact"], ["[id]/actions/route.ts", "manager.customers.suspend"]] as const) {
  const src = readFileSync(join(root, f), "utf8");
  check(`${f}: needs ${perm} and is rate-limited 10/min`, src.includes(`"${perm}"`) && /managerWriteLimit\(ctx, "[a-z-]+", 10\)/.test(src));
}
const dal = readFileSync(join(__dirname, "../../src/lib/data-access/manager-customers.ts"), "utf8");
check("phone search goes through the audited RPC", dal.includes('rpc("ops_search_customer_by_phone"'));
const phoneDesk = readFileSync(join(__dirname, "../../src/lib/data-access/manager-phone-orders.ts"), "utf8");
const lookup = phoneDesk.slice(phoneDesk.indexOf("export async function lookupCaller"), phoneDesk.indexOf("export async function lookupCaller") + 1500);
check("the phone desk lookup uses ops_lookup_caller, not profiles", lookup.includes('rpc("ops_lookup_caller"') && !lookup.includes('from("profiles")'));
check("...as the service role with the manager's id (a signed-in session cannot call it)", lookup.includes("createAdminClient()") && /p_actor:\s*actorId/.test(lookup));
const deskAction = readFileSync("src/app/manager/new-order/actions.ts", "utf8");
const deskCall = deskAction.slice(deskAction.indexOf("export async function lookupCallerAction"), deskAction.indexOf("export async function loadShopMenuAction"));
check("...the action passes the signed-in manager's id and needs manager.phone_orders", /lookupCaller\(phone,\s*profile\.id\)/.test(deskCall) && deskCall.includes('staffFeatureOn("manager.phone_orders")'));
check("...and a lookup budget of at most 30 a minute (a number-by-number directory is not a phone desk)", /phone-order-lookup:\$\{profile\.id\}`,\s*(\d+)/.test(deskCall) && Number(/phone-order-lookup:\$\{profile\.id\}`,\s*(\d+)/.exec(deskCall)![1]) <= 30);
const board = readFileSync("src/lib/data-access/manager-orders.ts", "utf8");
check("the web board takes names through the server, not an embedded profile read (0162 gives a session its own row only)", !/profiles!/.test(board) && board.includes("peopleByIds("));
check("...and its rider list is scoped to the caller's zones", /export async function listRiders\(scope: ManagerScope\)/.test(board) && board.includes("scopedRiderIds(scope)"));
const otp = readFileSync(join(__dirname, "../../src/app/api/auth/otp/verify/route.ts"), "utf8");
check("OTP verify refuses a suspended customer before handing back a token",
  otp.includes("customerLoginRefusal(") && otp.indexOf("customerLoginRefusal(") < otp.indexOf("tokenHash: result.tokenHash"));
const pw = readFileSync(join(__dirname, "../../src/app/api/auth/password-login/route.ts"), "utf8");
check("password sign-in refuses a suspended customer before returning tokens",
  pw.includes("customerLoginRefusal(") && pw.indexOf("customerLoginRefusal(") < pw.indexOf("accessToken: data.session.access_token"));
const orders = readFileSync(join(__dirname, "../../src/app/api/orders/route.ts"), "utf8");
check("the orders route answers 403 account_restricted", orders.includes('error: "account_restricted"') && orders.includes("isAccountRestricted(err)"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
