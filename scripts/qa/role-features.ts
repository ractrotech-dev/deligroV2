/**
 * QA — role feature switches resolve the way the admin panel says they do.
 *
 * Precedence: this shop's / this person's override → the role-wide switch →
 * ON. "No row" must never read as "off", or applying migration 0052 (or an
 * empty table) would silently take features away from everybody.
 *
 * Pure, no I/O. Usage: npm run test:role-features
 */
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
