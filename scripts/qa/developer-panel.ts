/**
 * QA — the Developer panel is separate from the admin console.
 *
 * Admin is the company's operations; the Developer panel is the app's own
 * health, monitoring and maintenance. The two roles are separate on purpose
 * (an account has one role), so this pins, offline:
 *   - the `developer` role exists and routes only to the Developer portal;
 *   - an admin is not routed there, and a developer is not routed to admin;
 *   - everything under /developer and the data layer behind it checks the
 *     developer role, and nothing in it still accepts "admin";
 *   - nothing in the admin console imports the monitoring data layer;
 *   - the old admin observability links redirect;
 *   - the sign-in door is public and the proxy gates the panel;
 *   - the role migration only adds the enum value.
 *
 * Usage: npm run test:developer-panel
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  PORTALS,
  PORTAL_LIST,
  PORTAL_LOGIN_PATHS,
  isOperatorPath,
  loginPathForRole,
  portalForPath,
} from "../../src/lib/auth/portals";
import { surfacesForRole } from "../../src/lib/auth/surfaces";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8").split("\r\n").join("\n");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(root, f).split(sep).join("/");

console.log("\n═══ the role and its door ═══");
check("the Role type includes developer", read("src/lib/auth.ts").includes('"developer"'), true);
check("the Developer portal accepts only the developer role", JSON.stringify(PORTALS.developer.roles), JSON.stringify(["developer"]));
check("an admin is not routed into it", PORTALS.developer.roles.includes("admin"), false);
check("a developer is not routed into the admin console", PORTALS.admin.roles.includes("developer"), false);
check("the vendor and manager portals do not take developers", [PORTALS.vendor, PORTALS.manager, PORTALS.driver].some((p) => p.roles.includes("developer")), false);
check("a developer's sign-in is the developer door", loginPathForRole("developer"), "/developer/login");
check("the panel's home is /developer", PORTALS.developer.home, "/developer");
check("the proxy treats /developer as an operator portal", isOperatorPath("/developer/observability/issues"), true);
check("and attributes it to the developer portal", portalForPath("/developer")?.key, "developer");
check("the developer sign-in page is public", PORTAL_LOGIN_PATHS.includes("/developer/login"), true);
check("the portal is in the proxy's list", PORTAL_LIST.some((p) => p.key === "developer"), true);
check("an admin is offered no Developer surface", surfacesForRole("admin").some((s) => s.key === "developer"), false);
check("a developer is offered the Developer surface", surfacesForRole("developer").some((s) => s.key === "developer"), true);
check("and not the admin console", surfacesForRole("developer").some((s) => s.key === "admin"), false);
check("a customer is offered neither", surfacesForRole("customer").some((s) => s.key === "developer" || s.key === "admin"), false);

console.log("\n═══ every check under /developer is a developer check ═══");
const devFiles = walk(join(root, "src/app/developer")).map(rel);
const obsLib = ["src/lib/obs/read.ts", "src/lib/obs/metrics.ts", "src/lib/obs/emit.ts"];
const guarded = [...devFiles, ...obsLib];
const stillAdmin = guarded.filter((f) => read(f).includes('requireRole("admin")'));
check("nothing in the panel or the monitoring data layer accepts admin", stillAdmin.length, 0);
if (stillAdmin.length) console.log(`    ${stillAdmin.join(", ")}`);
check("the panel layout requires the developer role", read("src/app/developer/layout.tsx").includes('requireRole("developer")'), true);
check("the observability layout requires it again", read("src/app/developer/observability/layout.tsx").includes('requireRole("developer")'), true);
const actions = read("src/app/developer/observability/actions.ts");
const bodies = actions.split("export async function ").slice(1);
// An action is guarded when it calls requireRole itself, or goes through the
// shared adminClient() helper, whose first line is requireRole("developer").
const helper = actions.slice(actions.indexOf("async function adminClient"), actions.indexOf("async function adminClient") + 200);
check("the shared client helper checks the role first", helper.indexOf('requireRole("developer")') > 0 && helper.indexOf('requireRole("developer")') < helper.indexOf("createAdminClient()"), true);
const unguarded = bodies.filter((b) => !b.includes('requireRole("developer")') && !b.includes("adminClient()")).map((b) => b.split("(")[0]);
check(`every one of the ${bodies.length} observability actions is guarded`, unguarded.length, 0);
if (unguarded.length) console.log(`    unguarded: ${unguarded.join(", ")}`);
const firstUse = (b: string) => Math.min(...["requireRole(\"developer\")", "adminClient()"].map((n) => (b.includes(n) ? b.indexOf(n) : Infinity)));
const touchesDataFirst = bodies.filter((b) => { const g = firstUse(b); const d = ["createAdminClient()", ".from(", "supabase."].map((n) => (b.includes(n) ? b.indexOf(n) : Infinity)); return Math.min(...d) < g; }).map((b) => b.split("(")[0]);
check("and each checks before it touches data", touchesDataFirst.length, 0);
check("the monitoring data layer checks it where RLS is bypassed", read("src/lib/obs/read.ts").includes('requireRole("developer")') && read("src/lib/obs/metrics.ts").includes('requireRole("developer")'), true);

console.log("\n═══ the admin console holds nothing technical ═══");
const adminFiles = [...walk(join(root, "src/app/admin")), ...walk(join(root, "src/components/admin"))].map(rel);
const readsObs = adminFiles.filter((f) => /from "@\/lib\/obs\/(read|metrics)"|components\/developer\//.test(read(f)));
check("no admin file imports the monitoring data layer or developer UI", readsObs.length, 0);
if (readsObs.length) console.log(`    ${readsObs.join(", ")}`);
check("the admin nav has no Observability entry", /href:\s*"\/(admin|developer)\/observability"/.test(read("src/components/admin/admin-nav.ts")), false);
check("no observability folder is left under /admin", devFiles.length > 0 && !adminFiles.some((f) => f.startsWith("src/app/admin/observability")), true);
check("the monitoring UI lives with the developer components", adminFiles.some((f) => /obs-(ui|ago)/.test(f)), false);

console.log("\n═══ Feature access ═══");
const featActions = read("src/app/developer/features/actions.ts");
const featPage = read("src/app/developer/features/page.tsx");
check("the switch action requires the developer role", featActions.includes('requireRole("developer")') && !featActions.includes('requireRole("admin")'), true);
check("the Feature access page requires it too", featPage.includes('requireRole("developer")') && !featPage.includes('requireRole("admin")'), true);
check("the switch action is still rate limited and validated", featActions.includes("rateLimit(") && featActions.includes("isFeatureKey(input.feature)"), true);
check("the admin nav has no Feature access entry", read("src/components/admin/admin-nav.ts").includes("/admin/settings/features"), false);
check("no admin file links to the old Feature access page", adminFiles.some((f) => read(f).includes("settings/features")), false);
check("the Developer nav lists Feature access under Configuration", read("src/components/developer/developer-nav.ts").includes('group: "Configuration"'), true);
check("the old Feature access URL redirects", read("next.config.ts").includes('source: "/admin/settings/features"') && read("next.config.ts").includes('destination: "/developer/features"'), true);
check("a switch change re-reads the developer page", featActions.includes('revalidatePath("/developer/features")'), true);

console.log("\n═══ links and sign-out ═══");
const cfg = read("next.config.ts");
check("the old observability URL redirects", cfg.includes('source: "/admin/observability"') && cfg.includes('destination: "/developer/observability"'), true);
check("and its sub-pages redirect", cfg.includes('source: "/admin/observability/:path*"') && cfg.includes('destination: "/developer/observability/:path*"'), true);
check("developer sign-out returns to the developer door", read("src/components/developer/developer-sidebar.tsx").includes("/auth/signout?next=/developer/login"), true);
check("the panel is never indexed", read("src/app/developer/layout.tsx").includes("index: false"), true);
check("and neither is its sign-in page", read("src/app/(portal-auth)/developer/login/page.tsx").includes("index: false"), true);

console.log("\n═══ the database migration ═══");
const mig = read("supabase/migrations/0059_developer_role_enum.sql");
const sql = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
check("it adds the enum value", /alter type public\.user_role add value if not exists 'developer';/.test(sql), true);
check("and does nothing else (a new enum label cannot be used in the same transaction)", sql.replace(/\s+/g, " "), "alter type public.user_role add value if not exists 'developer';");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
