/**
 * QA — finance reconciliation (§7 tracking 9): the route's permission rule
 * (orders/online need finance.view; cash needs finance.view OR manager.cash),
 * query validation, and that the data layer takes every state from the SQL
 * mirror of finance-rules (0157) rather than recomputing it. The states
 * themselves are proven against finance-rules in manager-finance-sql-parity.
 *
 * Usage: npx tsx scripts/qa/manager-reconciliation.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { reconciliationPermission, parseReconciliationQuery } from "../../src/lib/ops/reconciliation-query";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail)}`}`); }
}
const NOW = new Date("2026-10-21T10:00:00.000Z");
const P = (q: string) => new URLSearchParams(q);

console.log("\n── permission rule ──");
const perms = (o: Record<string, boolean>) => ({ "manager.finance.view": false, "manager.cash": false, ...o });
check("orders with finance.view → allowed", reconciliationPermission("orders", perms({ "manager.finance.view": true }), false) === null);
check("orders with only manager.cash → manager.finance.view denied", reconciliationPermission("orders", perms({ "manager.cash": true }), false) === "manager.finance.view");
check("online with only manager.cash → denied", reconciliationPermission("online", perms({ "manager.cash": true }), false) === "manager.finance.view");
check("cash with only manager.cash → allowed", reconciliationPermission("cash", perms({ "manager.cash": true }), false) === null);
check("cash with only finance.view → allowed", reconciliationPermission("cash", perms({ "manager.finance.view": true }), false) === null);
check("cash with neither → denied", reconciliationPermission("cash", perms({}), false) !== null);
check("an admin always passes", reconciliationPermission("orders", perms({}), true) === null);

console.log("\n── query ──");
const q = parseReconciliationQuery(P("section=orders&state=paid_mismatch"), NOW);
check("section and state parsed", q.ok && q.section === "orders" && q.state === "paid_mismatch", q);
check("section defaults to orders", (() => { const r = parseReconciliationQuery(P(""), NOW); return r.ok && r.section === "orders"; })());
check("an unknown section → bad_request", !parseReconciliationQuery(P("section=bank"), NOW).ok);
check("a state from another section → bad_request", !parseReconciliationQuery(P("section=cash&state=paid_mismatch"), NOW).ok);
check("online states accepted", parseReconciliationQuery(P("section=online&state=online_mismatch"), NOW).ok);
check("cash states accepted", parseReconciliationQuery(P("section=cash&state=disputed"), NOW).ok);
check("a reversed range → bad_range", (() => { const r = parseReconciliationQuery(P("from=2026-10-10&to=2026-10-01"), NOW); return !r.ok && r.error === "bad_range"; })());

console.log("\n── structure ──");
const route = existsSync("src/app/api/manager/finance/reconciliation/route.ts") ? readFileSync("src/app/api/manager/finance/reconciliation/route.ts", "utf8") : "";
check("the route exists", route.length > 0);
check("the route signs in with managerApiContext() and applies the section's rule", /managerApiContext\(\)/.test(route) && /reconciliationPermission\(/.test(route));
check("the route is read-limited", /financeReadLimit\(/.test(route));
const data = readFileSync("src/lib/data-access/manager-finance.ts", "utf8");
check("orders states come from ops_reconciliation_orders", /\("ops_reconciliation_orders", \{/.test(data));
check("cash comes from ops_cash_reconciliation", /"ops_cash_reconciliation"/.test(data));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
