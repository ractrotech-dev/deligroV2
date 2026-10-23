/**
 * QA — the manager gate, run for real (Phase 10, Task 4).
 *
 * manager-permission-matrix.ts proves every route opens with managerApiContext and asks
 * for a catalog permission. This proves what that gate then DOES, with the real
 * managerApiContext, the real feature-flag reader and the real scope rules; only the
 * edges are stubbed (the session, the database, the zones table, rate limiting):
 *
 *   a. no session                              -> 401 unauthenticated
 *   b. signed in as a customer / vendor / rider -> 403 forbidden
 *   c. manager, switch turned off              -> 403 permission_denied (names the switch)
 *   d. every default-off power, with NO flag rows, and with the flag read FAILING
 *                                              -> denied (fail closed); default-on powers stay allowed
 *   e. manager, switch on                      -> a context with their zones and permissions
 *   f. admin                                   -> every zone, every permission
 *   g. a manager with no zones, or zones that cannot be read -> an empty scope, never "all"
 *   h. narrowing to a zone they do not hold    -> never widens
 *   i. backend not configured                  -> 503
 *
 * Offline. Usage: npx tsx --conditions=react-server scripts/qa/manager-gate.ts
 */
import Module from "node:module";
import { FEATURES } from "../../src/lib/features/catalog";
import { narrowScope, scopeAllows, type ManagerScope } from "../../src/lib/auth/manager-scope";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  if (!cond || process.argv.includes("--verbose")) console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`, cond || detail === undefined ? "" : detail);
}

const MANAGER = "00000000-0000-0000-0000-0000000000aa";
const Z1 = "11111111-1111-1111-1111-111111111111";
const Z2 = "22222222-2222-2222-2222-222222222222";

interface World {
  configured: boolean;
  profile: { id: string; role: string } | null;
  zones: string[] | "error";
  /** rows of role_feature_flags, or "error" for a failing read */
  flags: { feature: string; subject_kind: string; subject_id: string | null; enabled: boolean }[] | "error";
}

// ── stub the edges, keep the logic ──
const stubs: Record<string, unknown> = {};
let world: World;
const O = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const realLoad = O._load;
O._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};

stubs["server-only"] = {};
stubs["@/lib/auth"] = { getProfile: async () => world.profile };
stubs["@/lib/supabase/config"] = { get isSupabaseConfigured() { return world.configured; } };
stubs["@/lib/rate-limit"] = { rateLimit: async () => ({ ok: true }), tooManyRequests: () => new Response(null, { status: 429 }) };
stubs["@/lib/data-access/zones"] = {
  listStaffZoneIds: async () => {
    if (world.zones === "error") throw new Error("staff_zones unreadable");
    return world.zones;
  },
};
stubs["@/lib/supabase/admin"] = {
  createAdminClient: () => ({
    from: () => ({
      select: async () =>
        world.flags === "error" ? { data: null, error: { message: "boom", code: "XX000" } } : { data: world.flags, error: null },
    }),
  }),
};

/** A fresh copy of the gate (the flag reader caches rows for 15 s). */
function freshGate(): { managerApiContext: (p?: string) => Promise<unknown> } {
  const cache = (Module as unknown as { _cache: Record<string, unknown> })._cache;
  for (const k of Object.keys(cache)) if (/manager-api\.server|flags\.server/.test(k)) delete cache[k];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../src/lib/auth/manager-api.server");
}

async function run(w: Partial<World>, permission?: string) {
  world = { configured: true, profile: { id: MANAGER, role: "manager" }, zones: [Z1], flags: [], ...w };
  const gate = freshGate();
  return (await gate.managerApiContext(permission)) as Response & {
    profile?: { id: string; role: string };
    scope?: ManagerScope;
    permissions?: Record<string, boolean>;
  };
}
const status = (r: unknown) => (r instanceof Response ? r.status : 200);
const body = async (r: unknown) => (r instanceof Response ? ((await r.clone().json()) as { error?: string; permission?: string }) : {});

(async () => {
  const keys = FEATURES.filter((f) => f.role === "manager");
  const defaultOff = keys.filter((f) => f.defaultOn === false);
  const defaultOn = keys.filter((f) => f.defaultOn !== false);
  console.log(`── gate: ${keys.length} manager permissions (${defaultOff.length} default-off) ──`);

  // i. backend not configured
  let r = await run({ configured: false });
  ok("i. backend not configured -> 503", status(r) === 503, status(r));

  // a. no session
  r = await run({ profile: null });
  ok("a. no session -> 401", status(r) === 401 && (await body(r)).error === "unauthenticated");

  // b. wrong roles
  for (const role of ["customer", "restaurant", "driver", "developer"]) {
    r = await run({ profile: { id: MANAGER, role } }, "manager.orders.view");
    ok(`b. a ${role} -> 403 forbidden`, status(r) === 403 && (await body(r)).error === "forbidden", status(r));
  }

  // c. switch off (an explicit per-person row), for a default-on power
  r = await run({ flags: [{ feature: "manager.orders.view", subject_kind: "profile", subject_id: MANAGER, enabled: false }] }, "manager.orders.view");
  ok("c. manager with their switch off -> 403 permission_denied naming the switch", status(r) === 403 && (await body(r)).error === "permission_denied" && (await body(r)).permission === "manager.orders.view");
  // ...and a role-wide off applies too
  r = await run({ flags: [{ feature: "manager.orders.view", subject_kind: "role", subject_id: null, enabled: false }] }, "manager.orders.view");
  ok("c. role-wide switch off -> 403", status(r) === 403);
  // ...but another person's switch does not
  r = await run({ flags: [{ feature: "manager.orders.view", subject_kind: "profile", subject_id: "00000000-0000-0000-0000-0000000000bb", enabled: false }] }, "manager.orders.view");
  ok("c. someone else's switch off does not affect this manager", status(r) === 200, status(r));

  // d. default-off powers: no rows at all, and a failing read
  for (const f of defaultOff) {
    r = await run({ flags: [] }, f.key);
    ok(`d. default-off ${f.key}: no flag rows -> denied`, status(r) === 403, status(r));
    r = await run({ flags: "error" }, f.key);
    ok(`d. default-off ${f.key}: flag read fails -> denied (fail closed)`, status(r) === 403, status(r));
    r = await run({ flags: [{ feature: f.key, subject_kind: "profile", subject_id: MANAGER, enabled: true }] }, f.key);
    ok(`d. default-off ${f.key}: an admin granting it to this manager -> allowed`, status(r) === 200, status(r));
    r = await run({ flags: [{ feature: f.key, subject_kind: "profile", subject_id: "00000000-0000-0000-0000-0000000000bb", enabled: true }] }, f.key);
    ok(`d. default-off ${f.key}: granted to someone else -> still denied`, status(r) === 403, status(r));
  }
  for (const f of defaultOn) {
    r = await run({ flags: "error" }, f.key);
    ok(`d. default-on ${f.key}: flag read fails -> still allowed`, status(r) === 200, status(r));
  }

  // e. permission on -> context
  r = await run({ zones: [Z1, Z2], flags: [] }, "manager.orders.view");
  ok("e. manager, switch on -> context with their zones", status(r) === 200 && r.scope && !r.scope.all && (r.scope as { zoneIds: string[] }).zoneIds.join() === [Z1, Z2].join());
  ok("e. their permission map shows default-off powers as off", r.permissions?.["manager.finance.approve_payment"] === false && r.permissions?.["manager.orders.view"] === true);

  // f. admin
  r = await run({ profile: { id: MANAGER, role: "admin" }, zones: [], flags: [] }, "manager.finance.approve_payment");
  ok("f. admin -> every zone", status(r) === 200 && r.scope?.all === true);
  ok("f. admin -> every permission, default-off included", keys.every((k) => r.permissions?.[k.key] === true));

  // g. zones
  r = await run({ zones: [] }, "manager.orders.view");
  ok("g. a manager with no zones gets an empty scope, not 'all'", status(r) === 200 && r.scope?.all === false && (r.scope as { zoneIds: string[] }).zoneIds.length === 0);
  r = await run({ zones: "error" }, "manager.orders.view");
  ok("g. unreadable zones -> empty scope (fail closed)", status(r) === 200 && r.scope?.all === false && (r.scope as { zoneIds: string[] }).zoneIds.length === 0);
  const none = r.scope as ManagerScope;
  ok("g. an empty scope allows nothing, not even an unzoned row", !scopeAllows(none, Z1) && !scopeAllows(none, null));

  // h. narrowing never widens
  const held: ManagerScope = { all: false, zoneIds: [Z1] };
  const narrowedToOther = narrowScope(held, Z2);
  ok("h. narrowing to a zone they do not hold allows nothing", !scopeAllows(narrowedToOther, Z1) && !scopeAllows(narrowedToOther, Z2));
  const narrowedToOwn = narrowScope(held, Z1);
  ok("h. narrowing to their own zone keeps it", scopeAllows(narrowedToOwn, Z1) && !scopeAllows(narrowedToOwn, Z2));
  const adminNarrow = narrowScope({ all: true }, Z2);
  ok("h. an admin narrowing to one zone sees only that zone", scopeAllows(adminNarrow, Z2) && !scopeAllows(adminNarrow, Z1));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
