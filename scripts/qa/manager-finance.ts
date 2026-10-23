/**
 * QA — manager Finance (§7): contract parsing and serialising (pure), the
 * overview's arithmetic from a rollup, and structural rules on the routes and
 * the data layer (permission first, every read scoped, no money recomputed in
 * a route). The live section runs when BASE is reachable and QA_MANAGER_COOKIE
 * is set.
 *
 * Usage: npx tsx scripts/qa/manager-finance.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { managerCookie } from "./_manager-session";
import { join } from "node:path";
import {
  parseFinanceRange,
  parseInitiateBody,
  parseRefundDecideBody,
  sortIssues,
  toSettlementSummary,
  decodeKeyCursor,
  encodeKeyCursor,
  type FinanceIssue,
  type FinanceNames,
} from "../../src/lib/ops/finance-contract";
import { dailyFromFinanceRollup, salesFromRollup, type FinanceRollup } from "../../src/lib/ops/finance-rollup";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 600)}`}`); }
}
const NOW = new Date("2026-10-21T10:00:00.000Z"); // 15:30 IST, 21 Oct
const P = (q: string) => new URLSearchParams(q);
const U = "11111111-1111-4111-8111-111111111111";

console.log("\n── range parsing ──");
const def = parseFinanceRange(P(""), NOW);
check("default: the last 30 IST days ending today", def.ok && def.range.from === "2026-09-22" && def.range.to === "2026-10-21", def);
check("from after to → bad_range", !parseFinanceRange(P("from=2026-10-10&to=2026-10-01"), NOW).ok);
check("367 days → bad_range", !parseFinanceRange(P("from=2025-10-19&to=2026-10-20"), NOW).ok);
check("366 days → ok", parseFinanceRange(P("from=2025-10-21&to=2026-10-21"), NOW).ok);
check("a future day → bad_range", !parseFinanceRange(P("from=2026-10-01&to=2026-10-22"), NOW).ok);
check("malformed → bad_range", !parseFinanceRange(P("from=1-10-2026&to=2026-10-21"), NOW).ok);
const z = parseFinanceRange(P("zone=nope"), NOW);
check("a non-uuid zone → bad_request zone", !z.ok && z.error === "bad_request" && z.field === "zone", z);

console.log("\n── initiate body ──");
const base = { clientActionId: U, vendorId: U, method: "bank" };
check("a period → ok", parseInitiateBody({ ...base, from: "2026-10-01", to: "2026-10-07" }, NOW).ok);
check("an order → ok", parseInitiateBody({ ...base, orderId: U }, NOW).ok);
check("both period and order → 400", !parseInitiateBody({ ...base, from: "2026-10-01", to: "2026-10-07", orderId: U }, NOW).ok);
check("neither → 400", !parseInitiateBody({ ...base }, NOW).ok);
const rev = parseInitiateBody({ ...base, from: "2026-10-07", to: "2026-10-01" }, NOW);
check("to before from → bad_range", !rev.ok && rev.error === "bad_range", rev);
check("cheque is not a method", !parseInitiateBody({ ...base, method: "cheque", orderId: U }, NOW).ok);

console.log("\n── refund decision body ──");
check("approve with a reason → ok", parseRefundDecideBody({ clientActionId: U, decision: "approve", reason: "Item missing" }).ok);
const short = parseRefundDecideBody({ clientActionId: U, decision: "deny", reason: "no" });
check("a 2-character reason → reason_required", !short.ok && short.error === "reason_required", short);
check("a 301-character reason → reason_required", !parseRefundDecideBody({ clientActionId: U, decision: "deny", reason: "x".repeat(301) }).ok);
check("decision must be approve|deny", !parseRefundDecideBody({ clientActionId: U, decision: "approved", reason: "Fine" }).ok);

console.log("\n── cursors ──");
const c = encodeKeyCursor("2026-10-20T10:00:00.000Z", U);
const back = decodeKeyCursor(c);
check("cursor round-trips", back !== "bad" && back !== null && back.at === "2026-10-20T10:00:00.000Z" && back.id === U);
check("garbage cursor → bad", decodeKeyCursor("%%%") === "bad");

console.log("\n── settlement summary ──");
const names: FinanceNames = {
  shop: (id) => ({ id, name: "Spice Hub" }),
  zoneOfShop: () => ({ id: U, name: "Bemetara" }),
  person: (id) => (id ? { id, name: "Asha" } : null),
};
const s = toSettlementSummary({
  id: U, restaurant_id: U, period_start: "2026-09-30T18:30:00.000Z", period_end: "2026-10-07T18:30:00.000Z",
  food_gross: 18450, commission: 2768, commission_gst: 498, other_charges: 0, refunds_recovered: 120, net_payable: 15064,
  status: "draft", kind: "batch", payment_ref: null, paid_at: null, paid_by: null, created_at: "2026-10-08T05:00:00Z", created_by: U,
}, names, 42, { id: U, status: "pending_approval" });
check("period shows the IST first and last days (exclusive end → last day)", s.periodStart === "2026-10-01" && s.periodEnd === "2026-10-07", s);
check("pinned keys", JSON.stringify(Object.keys(s)) === JSON.stringify(["id", "vendor", "zone", "kind", "status", "periodStart", "periodEnd", "orders",
  "foodGross", "commission", "commissionGst", "otherCharges", "refundsRecovered", "netPayable", "paymentRef", "paidAt", "paidBy", "createdAt", "createdBy", "request"]), Object.keys(s));
check("money is numbers, request carried", s.netPayable === 15064 && s.orders === 42 && s.request?.status === "pending_approval");

console.log("\n── overview arithmetic from a rollup ──");
const rollup: FinanceRollup = {
  summary: { orders: 3, delivered: 2, grossSales: 750, customerPaid: 820, discountVendor: 30, discountPlatform: 50, refundsTotal: 120,
    refundsCount: 1, refundsOnCancelled: 40, cancelledCount: 1, cancelledValue: 300, deliveryFees: 60, commission: 100, commissionGst: 18,
    otherCharges: 5, foodGross: 700, vendorNet: 577 },
  byDay: [{ date: "2026-10-20", orders: 3, customerPaid: 820, grossSales: 750, discountVendor: 30, discountPlatform: 50, refunds: 120,
    deliveryFees: 60, commission: 100, commissionGst: 18, otherCharges: 5, cancelledCount: 1, cancelledValue: 300 }],
  byVendor: [],
};
const sales = salesFromRollup(rollup.summary);
check("net sales = gross − discounts − refunds (750 − 80 − 120 = 550)", sales.netSales === 550, sales);
check("refunds on cancelled orders are not subtracted again", sales.refunds.total === 120 && sales.refunds.onCancelled === 40);
check("platform total = commission + GST + other (123)", sales.platformCommission.total === 123);
check("cancelled kept apart", sales.cancelled.count === 1 && sales.cancelled.value === 300);
const days = dailyFromFinanceRollup(rollup, { from: "2026-10-19", to: "2026-10-21" });
check("series is zero-filled across the range", days.length === 3 && days[0].netSales === 0 && days[1].netSales === 550 && days[2].orders === 0, days);
check("an empty rollup gives zeros, never NaN", Object.values(salesFromRollup({} as FinanceRollup["summary"])).every((v) => typeof v === "object" ? Object.values(v).every((x) => x === 0) : v === 0));

console.log("\n── issue ordering ──");
const mk = (since: string, id: string): FinanceIssue => ({ type: "failed_payment", severity: "critical", title: "x", detail: null, amount: null, since, subject: { kind: "order", id, label: "x" }, reference: null });
const sorted = sortIssues([mk("2026-10-01T00:00:00Z", "a"), mk("2026-10-03T00:00:00Z", "b"), mk("2026-10-02T00:00:00Z", "c")]);
check("newest first", sorted.map((i) => i.subject.id).join("") === "bca");

console.log("\n── structure ──");
const root = join(process.cwd(), "src/app/api/manager/finance");
const routes: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === "route.ts") routes.push(p); } };
if (existsSync(root)) walk(root);
for (const name of ["overview", "vendor-dues", "rider-dues", "issues", "rider-payouts"]) {
  check(`route finance/${name} exists`, routes.some((r) => r.replace(/\\/g, "/").endsWith(`finance/${name}/route.ts`)));
}
for (const r of routes) {
  const src = readFileSync(r, "utf8");
  const rel = r.replace(/\\/g, "/").split("src/app/api/manager/")[1];
  // Reconciliation's cash section also opens to manager.cash; its own rule is
  // checked in manager-reconciliation.ts.
  const gate = rel.includes("reconciliation") ? /reconciliationPermission\(/ : /managerApiContext\("manager\.finance\.view"\)/;
  check(`${rel}: the finance permission is checked first`, gate.test(src));
  check(`${rel}: no money arithmetic or service-role client in the route`, !/createAdminClient|breakdownOrder|net_payable\s*[-+*]/.test(src));
}
const data = readFileSync("src/lib/data-access/manager-finance.ts", "utf8");
check("data layer never selects * from orders", !/from\("orders"\)\.select\("\*"/.test(data));
// `financeIssuesForZone` is the alert engine's reader (the sweep has no manager, only a zone);
// no route may import it, so a manager can never reach it.
const SYSTEM_READS = ["financeIssuesForZone"];
const unscoped = [...data.matchAll(/export async function (\w+)\(([^)]*)/g)]
  .filter((m) => !/scope: ManagerScope/.test(m[2]) && !SYSTEM_READS.includes(m[1]))
  .map((m) => m[1]);
check("every exported list/read takes a scope", unscoped.length === 0, unscoped);
check("the system-only readers are used by the alert engine, never by a route",
  SYSTEM_READS.every((n) => routes.every((r) => !readFileSync(r, "utf8").includes(n))));
check("a manager with no zones short-circuits (isEmpty) before any rollup", (data.match(/isEmpty\(zones\)/g) ?? []).length >= 8);
check("money comes from the 0157 rollups, not inline sums of orders", /ops_finance_rollup/.test(data) && /ops_vendor_dues_scoped/.test(data) && !/from\("orders"\)\.select\("[^"]*total[^"]*"\)[^;]*reduce/.test(data));

// ── live (optional) ─────────────────────────────────────────────────────────
async function live() {
  const BASE = process.env.BASE ?? "http://localhost:3005";
  try { await fetch(`${BASE}/api/app-version?app=manager&versionCode=1`); } catch { console.log("\n(live section skipped: no server)"); return; }
  console.log("\n── live ──");
  const anon = await fetch(`${BASE}/api/manager/finance/overview`);
  check("unauthenticated → 401", anon.status === 401, anon.status);
  const cookie = await managerCookie();
  if (!cookie) { console.log("(signed-in checks skipped: no manager login)"); return; }
  const r = await fetch(`${BASE}/api/manager/finance/overview`, { headers: { cookie } });
  check("signed-in overview → 200 or 403 permission_denied", r.status === 200 || r.status === 403, r.status);
}

void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
