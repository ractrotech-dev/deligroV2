/**
 * Cash records are zone-scoped on the web /manager portal too (Phase 1 review
 * finding 4), and /api/manager/me does not hide a failed zone read (finding 7).
 *
 * Usage: npx tsx scripts/qa/manager-cash-scope.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRecordZone } from "../../src/lib/auth/manager-scope";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

const Z1 = "11111111-1111-4111-8111-111111111111";
const Z2 = "22222222-2222-4222-8222-222222222222";
const ZX = "99999999-9999-4999-8999-999999999999";

console.log("── which zone a cash record belongs to ──");
let r = resolveRecordZone({ all: false, zoneIds: [Z1] }, null);
ok("a one-zone manager's record lands in that zone", r.ok && r.zoneId === Z1);
r = resolveRecordZone({ all: false, zoneIds: [Z1, Z2] }, null);
ok("a several-zone manager must choose", !r.ok && /zone/i.test(r.error));
r = resolveRecordZone({ all: false, zoneIds: [Z1, Z2] }, Z2);
ok("...and their choice is used", r.ok && r.zoneId === Z2);
r = resolveRecordZone({ all: false, zoneIds: [Z1, Z2] }, ZX);
ok("a zone outside their scope is refused", !r.ok);
r = resolveRecordZone({ all: false, zoneIds: [Z1] }, "not-a-uuid");
ok("a malformed zone is refused", !r.ok);
r = resolveRecordZone({ all: false, zoneIds: [] }, null);
ok("a manager with no zones cannot record", !r.ok);
r = resolveRecordZone({ all: true }, null);
ok("an admin without a choice leaves it to the default zone", r.ok && r.zoneId === null);
r = resolveRecordZone({ all: true }, Z2);
ok("an admin's choice is used", r.ok && r.zoneId === Z2);

console.log("\n── every cash read is scoped ──");
const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const cod = read("src/lib/data-access/cod-handovers.ts");
const exp = read("src/lib/data-access/operational-expenses.ts");
for (const fn of ["listCodHandovers", "codDaySummary", "codOutstandingSummary"]) {
  ok(`${fn} takes a scope`, new RegExp(`export async function ${fn}\\(\\s*scope: ManagerScope`).test(cod));
}
for (const fn of ["listOperationalExpenses", "operationalExpenseMonthTotals"]) {
  ok(`${fn} takes a scope`, new RegExp(`export async function ${fn}\\(\\s*scope: ManagerScope`).test(exp));
}
/** The text of one exported function, up to the next export. */
const body = (src: string, fn: string) => {
  const start = src.indexOf(`export async function ${fn}(`);
  const next = src.indexOf("\nexport ", start + 1);
  return start < 0 ? "" : src.slice(start, next < 0 ? undefined : next);
};
const scoped = (b: string) => /applyZoneScope\(|scopeZoneIds\(/.test(b);
for (const fn of ["listCodHandovers", "codDaySummary", "codOutstandingSummary"]) {
  ok(`${fn} applies the scope`, scoped(body(cod, fn)));
}
ok("codDaySummary filters both deliveries and handovers",
  /in\("orders\.zone_id"/.test(body(cod, "codDaySummary")) && /in\("zone_id"/.test(body(cod, "codDaySummary")));
ok("codOutstandingSummary filters both deliveries and handovers",
  /in\("orders\.zone_id"/.test(body(cod, "codOutstandingSummary")) && /in\("zone_id"/.test(body(cod, "codOutstandingSummary")));
for (const fn of ["listOperationalExpenses", "operationalExpenseMonthTotals"]) {
  ok(`${fn} applies the scope`, scoped(body(exp, fn)));
}
ok("a handover is written with its zone", /zone_id: input\.zoneId/.test(cod));
ok("an expense is written with its zone", /zone_id: input\.zoneId/.test(exp));

console.log("\n── riders on the cash screen are the manager's riders (review finding 13) ──");
{
  const page = read("src/app/manager/cash/page.tsx");
  const actions = read("src/app/manager/cash/actions.ts");
  const riders = read("src/lib/data-access/scoped-riders.ts");
  ok("the rider list is limited to the caller's zones", /scopedRiderIds\(scope\)/.test(page));
  ok("scopedRiderIds reads staff_zones by the scope's zones", /from\("staff_zones"\)/.test(riders) && /scopeZoneIds\(scope\)/.test(riders));
  ok("a handover from a rider outside the caller's zones is refused",
    /riderInScope\(/.test(body(actions, "recordHandoverAction")) &&
      body(actions, "recordHandoverAction").indexOf("riderInScope(") < body(actions, "recordHandoverAction").indexOf("recordCodHandover("));
  ok("an expense for a rider outside the caller's zones is refused",
    /riderInScope\(/.test(body(actions, "recordExpenseAction")) &&
      body(actions, "recordExpenseAction").indexOf("riderInScope(") < body(actions, "recordExpenseAction").indexOf("recordOperationalExpense("));
}

console.log("\n── /api/manager/me ──");
const me = read("src/app/api/manager/me/route.ts");
ok("a failed zone read is an error, not an empty list", !/listCitiesWithZones\(\)\.catch/.test(me));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
