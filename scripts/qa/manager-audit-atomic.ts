/**
 * Audited writes record their entry in the same transaction as the change
 * (design: "Audit log"; Phase 1 review finding 10b).
 *
 * Structural, like platform-separation.ts: it reads the source, because the
 * failure it guards against — a write followed by a best-effort log call that
 * can silently drop the entry — compiles and passes every runtime test.
 *
 * Usage: npx tsx scripts/qa/manager-audit-atomic.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

const audit = read("src/lib/data-access/ops-audit.ts");
ok("there is no best-effort logger to reach for", !/export async function logOpsActionSafely/.test(audit));

const zones = read("src/app/admin/settings/zones/actions.ts");
for (const rpc of ["ops_create_city", "ops_create_zone", "ops_update_zone", "ops_set_staff_zones"]) {
  ok(`zone admin uses ${rpc}`, zones.includes(`rpc("${rpc}"`));
}
ok(
  "zone admin never writes the zone tables directly",
  !/from\("(cities|delivery_zones|staff_zones)"\)\s*\.(insert|update|delete|upsert)/.test(zones)
);
ok("zone admin never logs after the fact", !/logOpsAction/.test(zones));

const sessions = read("src/app/api/manager/sessions/route.ts");
ok("sign out everywhere ends the others in one logged call", sessions.includes(`rpc("revoke_my_other_sessions"`));
ok("...and never a global sign-out with a log afterwards", !/scope:\s*"global"/.test(sessions) && !/logOpsAction/.test(sessions));

const password = read("src/app/api/manager/password/route.ts");
const logAt = password.indexOf("logOpsAction(");
const updateAt = password.indexOf("updateUserById(");
ok("a password change is on the record before it happens", logAt > -1 && updateAt > -1 && logAt < updateAt);
ok("...and ends the person's other sessions afterwards", password.indexOf(`rpc("revoke_my_other_sessions"`) > updateAt);

const flags = read("src/lib/features/flags.server.ts");
ok("a permission switch is saved and logged in one call", flags.includes(`rpc("ops_set_feature_switch"`));

// Admins grant manager powers (design: Admin → Feature access), not only developers.
const adminPage = read("src/app/admin/settings/feature-access/page.tsx");
const adminActions = read("src/app/admin/settings/feature-access/actions.ts");
ok("Admin → Feature access exists and checks for an admin", /requireRole\("admin"\)/.test(adminPage));
ok("...and its action checks for an admin too", /requireRole\("admin"\)/.test(adminActions));
const devActions = read("src/app/developer/features/actions.ts");
ok("the developer page keeps its own gate", /requireRole\("developer"\)/.test(devActions));
ok("both save through one shared function", /saveFeatureSwitch\(/.test(adminActions) && /saveFeatureSwitch\(/.test(devActions));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
