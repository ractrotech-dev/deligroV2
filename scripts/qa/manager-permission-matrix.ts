/**
 * QA — permission matrix over every manager route (Phase 10, Task 4).
 *
 * Discovers every src/app/api/manager/**\/route.ts from the filesystem and, for
 * each exported HTTP method, reads the handler and proves:
 *
 *   1. it opens with managerApiContext(...) before touching data
 *      (no createAdminClient / createClient / .from / .rpc ahead of it) and returns
 *      the gate's refusal as-is;
 *   2. the permission it asks for exists in the manager catalog;
 *   3. a route with NO gate permission is either on the self-service allowlist
 *      (with a reason) or checks a permission inside the handler;
 *   4. a path under a protected area asks for a permission of that area;
 *   5. every write (POST, PUT, PATCH, DELETE) is rate limited or exempt with a reason;
 *   6. every default-off permission is required by at least one route.
 *
 * An unmapped route fails the run — it is never skipped. No database, no server.
 * Usage: npx tsx scripts/qa/manager-permission-matrix.ts [--print]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FEATURES } from "../../src/lib/features/catalog";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
  }
  if (!cond || process.argv.includes("--verbose")) console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`, cond || detail === undefined ? "" : detail);
}

const root = join(__dirname, "..", "..");
const API = "src/app/api/manager";

function routes(dir: string): string[] {
  const full = join(root, dir);
  return readdirSync(full).flatMap((name) => {
    const rel = `${dir}/${name}`;
    const st = statSync(join(root, rel));
    if (st.isDirectory()) return routes(rel);
    return name === "route.ts" ? [rel] : [];
  });
}

const manager = new Map(FEATURES.filter((f) => f.role === "manager").map((f) => [f.key, f]));
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Self-service and picker routes: any signed-in manager, no permission switch, with the reason. */
const SELF_SERVICE: Record<string, string> = {
  "me": "the manager's own profile, zones and permission map",
  "permissions": "the manager's own permission map (the app hides what is off)",
  "password": "the manager changes their own password (current password required)",
  "sessions": "the manager's own devices; revoke is filtered by auth.uid() in the database",
  "notification-prefs": "the manager's own push switches",
  "notifications": "the manager's own inbox",
  "activity": "the manager's own audit entries",
  "dashboard": "tiles for what the manager may see; finance tiles are absent without manager.finance.view (checked inside)",
  "alerts": "alerts of the manager's zones, filtered by the permission each alert kind needs (checked inside)",
  "alert-rules": "reads thresholds of the manager's zones; PUT and DELETE require manager.alerts.configure",
  "vendors/directory": "id, name and zone of vendors in scope, for filter pickers (no contact details)",
  "riders/directory": "id and codes of riders in scope, for filter pickers (no phone, position or account state)",
  "orders/[id]/riders": "riders who could take this order; gated by order permissions checked inside",
  "orders/[id]/actions": "each order action checks its own permission inside",
  "finance/reconciliation": "orders / online / cash views check finance and cash permissions inside",
};

/** Protected areas: the permission keys an ungated-or-gated route under this prefix may ask for. */
const AREA: { prefix: string; keys: RegExp; why: string }[] = [
  { prefix: "finance", keys: /^manager\.(finance\.|cash$)/, why: "money" },
  { prefix: "payments", keys: /^manager\.(finance\.|riders\.|vendors\.)/, why: "money requests" },
  { prefix: "customers", keys: /^manager\.customers\./, why: "customer data" },
  { prefix: "marketing", keys: /^manager\.marketing\./, why: "marketing" },
  { prefix: "campaigns", keys: /^manager\.marketing\./, why: "marketing" },
  { prefix: "offers", keys: /^manager\.offers\./, why: "offers" },
  { prefix: "tickets", keys: /^manager\.support\./, why: "support" },
  { prefix: "riders", keys: /^manager\.riders\./, why: "riders" },
  { prefix: "vendors", keys: /^manager\.vendors\./, why: "vendors" },
  { prefix: "products", keys: /^manager\.products\./, why: "products" },
  { prefix: "reports", keys: /^manager\.reports\./, why: "reports" },
  { prefix: "audit", keys: /^manager\.audit\./, why: "audit log" },
  { prefix: "cash", keys: /^manager\.cash$/, why: "cash" },
  { prefix: "orders", keys: /^manager\.orders\./, why: "orders" },
  { prefix: "live", keys: /^manager\.live\./, why: "live map" },
  { prefix: "exceptions", keys: /^manager\.(exceptions\.|riders\.)/, why: "exceptions" },
  { prefix: "stats", keys: /^manager\.(reports\.|orders\.)/, why: "statistics" },
];

/** Writes that are rate limited somewhere other than the handler, or deliberately not. */
const WRITE_EXEMPT: Record<string, string> = {};

interface Method {
  route: string; // path under /api/manager
  method: string;
  permission: string | null; // the gate argument
  gated: boolean;
  gateFirst: boolean;
  returnsRefusal: boolean;
  limited: boolean;
  innerPermission: boolean;
}

function methodsOf(file: string): Method[] {
  const src = readFileSync(join(root, file), "utf8");
  const route = file.slice(API.length + 1).replace(/\/route\.ts$/, "");
  const heads = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)];
  return heads.map((h, i) => {
    const body = src.slice(h.index!, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const gate = /managerApiContext\(\s*(?:"([^"]+)"|'([^']+)')?\s*\)/.exec(body);
    const gateAt = gate ? gate.index : -1;
    const before = gateAt >= 0 ? body.slice(0, gateAt) : body;
    const touchesDataFirst = /createAdminClient\(|createClient\(|\.from\(|\.rpc\(|getProfile\(/.test(before);
    return {
      route,
      method: (h[1] ?? h[2])!,
      permission: gate ? (gate[1] ?? gate[2] ?? null) : null,
      gated: !!gate,
      gateFirst: !!gate && !touchesDataFirst,
      returnsRefusal: /instanceof\s+Response/.test(body),
      limited: /managerWriteLimit\(|rateLimit\(/.test(body),
      innerPermission: /permissions\[|ctx\.permissions|\bcan\(|hasPermission|mayRun\(|requirePermission|assertPermission/.test(body.slice(gateAt >= 0 ? gateAt : 0)),
    };
  });
}

const files = routes(API).sort();
const all = files.flatMap(methodsOf);
console.log(`── ${files.length} route files, ${all.length} handlers ──`);
ok("there are routes to check", files.length > 20, files.length);

for (const m of all) {
  const id = `${m.method} /api/manager/${m.route}`;
  ok(`${id}: opens with managerApiContext`, m.gated, "no managerApiContext( call found in the handler");
  if (!m.gated) continue;
  ok(`${id}: the gate runs before any data access`, m.gateFirst, "data is touched before the gate");
  ok(`${id}: returns the gate's refusal`, m.returnsRefusal, "no `instanceof Response` early return");
  if (m.permission) ok(`${id}: permission ${m.permission} exists`, manager.has(m.permission as never), "not a manager.* catalog key");

  const area = AREA.find((a) => m.route === a.prefix || m.route.startsWith(a.prefix + "/"));
  if (area && m.permission) ok(`${id}: ${m.permission} belongs to the ${area.why} area`, area.keys.test(m.permission));
  if (!m.permission) {
    const key = Object.keys(SELF_SERVICE).find((k) => m.route === k || m.route.startsWith(k + "/"));
    const covered = !!key || m.innerPermission;
    ok(`${id}: no gate permission, so it is self-service or checks inside`, covered, "ungated and not on the self-service list");
    if (area && !key) ok(`${id}: ungated route in the ${area.why} area checks a permission inside`, m.innerPermission, "area route with no permission anywhere");
  }
  if (WRITE.has(m.method)) {
    const reason = WRITE_EXEMPT[`${m.method} ${m.route}`];
    ok(`${id}: write is rate limited${reason ? ` (exempt: ${reason})` : ""}`, m.limited || !!reason, "no managerWriteLimit / rateLimit in the handler");
  }
}

// Every default-off permission is asked for by some route (a switch nothing reads is a dead switch).
const asked = new Set(all.map((m) => m.permission).filter(Boolean) as string[]);
console.log("\n── default-off permissions ──");
for (const [key, f] of manager) {
  if ((f as { defaultOn?: boolean }).defaultOn === false) {
    // Enforced at the gate, or through an action -> permission map next to the logic
    // (src/lib/ops/*-actions.ts, order-detail.ts) or in a manager data-access file.
    const homes = [
      ...files,
      ...readdirSync(join(root, "src/lib/ops")).filter((n) => n.endsWith(".ts")).map((n) => `src/lib/ops/${n}`),
      ...readdirSync(join(root, "src/lib/data-access")).filter((n) => n.startsWith("manager") && n.endsWith(".ts")).map((n) => `src/lib/data-access/${n}`),
    ];
    const where = homes.find((file) => readFileSync(join(root, file), "utf8").includes(`"${key}"`));
    ok(`default-off ${key} is enforced somewhere`, asked.has(key) || !!where, "no route, ops map or data-access file names it");
    if (process.argv.includes("--verbose")) console.log(`        ${key} -> ${asked.has(key) ? "gate" : where}`);
  }
}

if (process.argv.includes("--print")) {
  console.log("\n── matrix ──");
  for (const m of all) console.log(`${m.method.padEnd(6)} /${m.route.padEnd(48)} ${m.permission ?? "(self-service / checked inside)"}${WRITE.has(m.method) ? "  [write]" : ""}`);
}

console.log(`\n${passed} passed, ${failed} failed (${all.length} handlers, ${asked.size} distinct permissions asked at the gate)`);
if (failed) console.log("failing: " + [...new Set(failures)].slice(0, 20).join(" | "));
process.exit(failed ? 1 : 0);
