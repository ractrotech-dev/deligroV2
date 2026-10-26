/**
 * QA — role feature switches resolve the way the admin panel says they do.
 *
 * Precedence: this shop's / this person's override → the role-wide switch →
 * ON. "No row" must never read as "off", or applying migration 0052 (or an
 * empty table) would silently take features away from everybody.
 *
 * The resolution checks are pure. The wiring checks at the end read source
 * files: every rider and vendor switch must be refused by the server, sent to
 * its app, and hidden there. Usage: npm run test:role-features
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, allOn, defaults, featuresFor } from "../../src/lib/features/catalog";
import { resolveFeatures, type FlagRow } from "../../src/lib/features/resolve";

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

const SHOP_A = "11111111-1111-1111-1111-111111111111";
const SHOP_B = "22222222-2222-2222-2222-222222222222";
const RIDER = "33333333-3333-3333-3333-333333333333";

console.log("\nRole feature switches\n");

// Catalogue sanity
check("every feature key is 'role.name' or 'role.area.name'", FEATURES.every((f) => /^[a-z_]+(\.[a-z_]+){1,2}$/.test(f.key)));
check("every feature key starts with its role", FEATURES.every((f) => f.key.startsWith(f.role + ".")));
check("feature keys are unique", new Set(FEATURES.map((f) => f.key)).size === FEATURES.length);
check("each role has switchable features", ["vendor", "manager", "driver"].every((r) => featuresFor(r as never).length > 0));

// No rows → everything on
const none = resolveFeatures("vendor", [], SHOP_A);
check("no rows: every vendor feature on", featuresFor("vendor").every((f) => none[f.key as keyof typeof none]));

// Role-wide off
const roleOff: FlagRow[] = [{ feature: "vendor.promotions", subject_kind: "role", subject_id: null, enabled: false }];
check("role-wide off applies to shop A", resolveFeatures("vendor", roleOff, SHOP_A)["vendor.promotions"] === false);
check("role-wide off applies to a shop with no id", resolveFeatures("vendor", roleOff, null)["vendor.promotions"] === false);
check("role-wide off leaves other features on", resolveFeatures("vendor", roleOff, SHOP_A)["vendor.menu_edit"] === true);

// Shop override beats role-wide
const override: FlagRow[] = [
  ...roleOff,
  { feature: "vendor.promotions", subject_kind: "restaurant", subject_id: SHOP_A, enabled: true },
];
check("shop A's override ON beats role-wide OFF", resolveFeatures("vendor", override, SHOP_A)["vendor.promotions"] === true);
check("shop B still follows role-wide OFF", resolveFeatures("vendor", override, SHOP_B)["vendor.promotions"] === false);

// Override off with role on
const shopOff: FlagRow[] = [{ feature: "vendor.menu_edit", subject_kind: "restaurant", subject_id: SHOP_B, enabled: false }];
check("per-shop OFF only affects that shop", resolveFeatures("vendor", shopOff, SHOP_B)["vendor.menu_edit"] === false && resolveFeatures("vendor", shopOff, SHOP_A)["vendor.menu_edit"] === true);

// Kind isolation: a profile row must not act as a shop override, and vice versa
const wrongKind: FlagRow[] = [{ feature: "vendor.menu_edit", subject_kind: "profile", subject_id: SHOP_A, enabled: false }];
check("a 'profile' row does not override a vendor shop", resolveFeatures("vendor", wrongKind, SHOP_A)["vendor.menu_edit"] === true);

// Riders
const riderRows: FlagRow[] = [
  { feature: "driver.history", subject_kind: "role", subject_id: null, enabled: false },
  { feature: "driver.history", subject_kind: "profile", subject_id: RIDER, enabled: true },
];
check("rider override ON beats role-wide OFF", resolveFeatures("driver", riderRows, RIDER)["driver.history"] === true);
check("other riders follow role-wide OFF", resolveFeatures("driver", riderRows, "x")["driver.history"] === false);

// Other roles untouched
check("vendor rows never change a rider's map", resolveFeatures("driver", roleOff, RIDER)["vendor.promotions"] === allOn()["vendor.promotions"]);

// Managers: every power in the design's permission table, sensitive ones off by default.
const MANAGER = "44444444-4444-4444-4444-444444444444";
const DEFAULT_ON = [
  "manager.orders.view", "manager.live.view", "manager.vendors.view", "manager.riders.view", "manager.products.view",
  "manager.support.manage", "manager.reports.view", "manager.move_status", "manager.assign_rider", "manager.reassign_rider",
  "manager.phone_orders", "manager.cash", "manager.call_customer", "manager.orders.escalate", "manager.alerts.configure",
  "manager.finance.view", "manager.marketing.manage", "manager.offers.manage", "manager.customers.view",
  "manager.vendors.status", "manager.riders.status", "manager.products.moderate", "manager.exceptions.decide",
];
const DEFAULT_OFF = [
  "manager.orders.correct", "manager.vendors.onboard", "manager.riders.onboard", "manager.finance.initiate_payment",
  "manager.finance.approve_payment", "manager.finance.adjust", "manager.customers.contact", "manager.customers.suspend",
  "manager.products.adjust_stock", "manager.audit.view_zone",
];
const keys = new Set<string>(FEATURES.map((f) => f.key));
const missing = [...DEFAULT_ON, ...DEFAULT_OFF].filter((k) => !keys.has(k));
check("every manager permission from the design exists", missing.length === 0, missing.join(", "));
const extra = featuresFor("manager").filter((f) => !DEFAULT_ON.includes(f.key) && !DEFAULT_OFF.includes(f.key));
check("no manager permission outside the design", extra.length === 0, extra.map((f) => f.key).join(", "));
const mgr = (rows: FlagRow[], who: string) => resolveFeatures("manager", rows, who) as Record<string, boolean>;
const mgrNone = mgr([], MANAGER);
check("no rows: default-on manager powers are on", DEFAULT_ON.every((k) => mgrNone[k] === true));
check("no rows: sensitive manager powers are OFF", DEFAULT_OFF.every((k) => mgrNone[k] === false));
check("defaults() agrees with no rows", DEFAULT_OFF.every((k) => (defaults() as Record<string, boolean>)[k] === false));
check("allOn() still turns everything on (admins)", Object.values(allOn()).every(Boolean));
const personOn: FlagRow[] = [{ feature: "manager.finance.approve_payment", subject_kind: "profile", subject_id: MANAGER, enabled: true }];
check("a per-person ON grants a default-off power", mgr(personOn, MANAGER)["manager.finance.approve_payment"] === true);
check("...to that person only", mgr(personOn, "someone-else")["manager.finance.approve_payment"] === false);
const roleOn: FlagRow[] = [{ feature: "manager.customers.contact", subject_kind: "role", subject_id: null, enabled: true }];
check("a role-wide ON grants a default-off power", mgr(roleOn, MANAGER)["manager.customers.contact"] === true);
const roleOnPersonOff: FlagRow[] = [...roleOn, { feature: "manager.customers.contact", subject_kind: "profile", subject_id: MANAGER, enabled: false }];
check("a per-person OFF beats role-wide ON", mgr(roleOnPersonOff, MANAGER)["manager.customers.contact"] === false);
const shopRow: FlagRow[] = [{ feature: "manager.audit.view_zone", subject_kind: "restaurant", subject_id: MANAGER, enabled: true }];
check("a 'restaurant' row cannot grant a manager power", mgr(shopRow, MANAGER)["manager.audit.view_zone"] === false);
check("the five original manager switches stay default-on",
  ["manager.phone_orders", "manager.cash", "manager.assign_rider", "manager.move_status", "manager.call_customer"].every((k) => mgrNone[k] === true));

// Riders and vendors: every section switch is enforced server-side, sent to
// the app and hidden there. Core work and SOS never get a switch.
const ROOT = join(__dirname, "..", "..");
const src = (rel: string) => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};
const RIDER_WIRING: Record<string, string[]> = {
  "driver.history": ["src/app/api/rider/history/route.ts", "apps/rider/lib/features/history/history_screen.dart"],
  "driver.earnings": ["src/lib/auth/rider-earnings-route.ts", "apps/rider/lib/features/earnings/earnings_widgets.dart"],
  "driver.incentives": ["src/app/api/rider/earnings/incentives/route.ts", "src/app/api/rider/dashboard/route.ts", "apps/rider/lib/core/feature_routes.dart"],
  "driver.performance": ["src/app/api/rider/performance/route.ts", "src/app/api/rider/ratings/route.ts", "apps/rider/lib/core/feature_routes.dart"],
  "driver.cash": ["src/lib/auth/rider-cash-route.ts", "apps/rider/lib/core/feature_routes.dart"],
  "driver.support": [
    "src/app/api/rider/support/tickets/route.ts",
    "src/app/api/rider/support/tickets/[id]/route.ts",
    "src/app/api/rider/support/tickets/[id]/messages/route.ts",
    "apps/rider/lib/core/feature_routes.dart",
  ],
};
for (const [key, files] of Object.entries(RIDER_WIRING)) {
  check(`${key} is in the catalog`, keys.has(key));
  const where = files.filter((f) => !src(f).includes(`"${key}"`) && !src(f).includes(`'${key}'`));
  check(`${key} is wired (server + app)`, where.length === 0, where.join(", "));
}
check("/api/rider/me sends every driver.* switch", src("src/app/api/rider/me/route.ts").includes('featuresFor("driver")'));
check("every cash route goes through riderCashGate (driver.cash)",
  ["collections", "deposits", "deposits/[id]", "disputes", "managers", "summary"].every((r) =>
    src(`src/app/api/rider/cash/${r}/route.ts`).includes("riderCashGate(")));
check("an emergency ticket is accepted with driver.support off",
  src("src/app/api/rider/support/tickets/route.ts").includes('defaultPriority(String(f.category ?? "")) !== "emergency"'));
check("the ticket list still sends Deligro's numbers with driver.support off",
  /supportOn \? listMyTickets/.test(src("src/app/api/rider/support/tickets/route.ts")));
check("no switch for a rider's SOS, safety, going online or deliveries",
  featuresFor("driver").every((f) => !/sos|safety|online|offer|deliver|accept/.test(f.key)));

const VENDOR_WIRING: Record<string, string[]> = {
  "vendor.reports": ["src/app/api/vendor/reports/route.ts", "src/app/api/vendor/analytics/route.ts"],
  "vendor.reviews": ["src/app/api/vendor/reviews/route.ts", "src/app/api/vendor/reviews/[id]/reply/route.ts", "src/app/vendor/reviews/page.tsx", "src/app/vendor/reviews/actions.ts", "src/components/vendor/vendor-nav.ts"],
  "vendor.marketing": ["src/app/api/vendor/marketing/route.ts", "src/app/api/vendor/marketing/[id]/cancel/route.ts"],
  "vendor.support": ["src/app/api/vendor/support/route.ts", "src/app/api/vendor/support/[id]/route.ts", "src/app/api/vendor/support/[id]/messages/route.ts", "src/app/api/vendor/support/attachments/route.ts"],
};
const gates = src("apps/vendor/lib/core/feature_gates.dart");
for (const [key, files] of Object.entries(VENDOR_WIRING)) {
  check(`${key} is in the catalog`, keys.has(key));
  const where = files.filter((f) => !src(f).includes(`"${key}"`));
  check(`${key} is refused by the server`, where.length === 0, where.join(", "));
  check(`${key} is hidden in the Partner app`, gates.includes(`'${key}'`));
}
check("/api/vendor/me sends every vendor.* switch", src("src/app/api/vendor/me/route.ts").includes('featuresFor("vendor")'));
check("no switch for a vendor seeing or accepting orders",
  featuresFor("vendor").every((f) => !/orders_view|accept|board/.test(f.key)));
check("rider and vendor switches all start on", [...featuresFor("driver"), ...featuresFor("vendor")].every((f) => f.defaultOn !== false));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
