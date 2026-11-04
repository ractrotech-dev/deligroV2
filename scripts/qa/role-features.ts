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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FEATURES, FEATURE_OFF_MESSAGE, ROLE_LABEL, ROLE_SUBJECT, allOn, defaults, featuresFor, pickRole } from "../../src/lib/features/catalog";
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
check("each role has switchable features", ["customer", "vendor", "manager", "driver"].every((r) => featuresFor(r as never).length > 0));
check("every feature has a group and off wording", FEATURES.every((f) => f.group.length > 0 && f.offMeans.length > 0));

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
  "manager.vendors.status", "manager.riders.status", "manager.products.moderate", "manager.exceptions.decide", "manager.weather.manage",
];
const DEFAULT_OFF = [
  "manager.orders.correct", "manager.vendors.onboard", "manager.riders.onboard", "manager.finance.initiate_payment",
  "manager.finance.approve_payment", "manager.finance.adjust", "manager.customers.contact", "manager.customers.suspend",
  "manager.products.adjust_stock", "manager.audit.view_zone", "manager.products.bulk_menu", "manager.products.replace_photo",
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
check("the Cash change to wallet switch stays in the catalog (owner: it goes live with the customer wallet)", keys.has("driver.cod_change"));
check("the switched-off message is English only (manager, partner and rider surfaces)", !/[\u0900-\u097F]/.test(FEATURE_OFF_MESSAGE));

// Customers: a person's override, a guest, and the two locked switches.
console.log("\nCustomers\n");
const ANNA = "55555555-5555-5555-5555-555555555555";
const customer = (rows: FlagRow[], who: string | null) => resolveFeatures("customer", rows, who) as Record<string, boolean>;
const tipsOff: FlagRow[] = [{ feature: "customer.tips", subject_kind: "role", subject_id: null, enabled: false }];
const customerKeys = featuresFor("customer").map((f) => f.key);
check("no rows: every customer feature is on except self pickup",
  customerKeys.every((k) => customer([], ANNA)[k] === (k !== "customer.self_pickup")));
check("self pickup is off by default, for a person and a guest",
  customer([], ANNA)["customer.self_pickup"] === false && customer([], null)["customer.self_pickup"] === false);
check("a guest follows the for-everyone value", customer(tipsOff, null)["customer.tips"] === false);
const tipsOnForAnna: FlagRow[] = [...tipsOff, { feature: "customer.tips", subject_kind: "profile", subject_id: ANNA, enabled: true }];
check("a customer's own ON beats for-everyone OFF", customer(tipsOnForAnna, ANNA)["customer.tips"] === true);
check("...and a guest doesn't get it", customer(tipsOnForAnna, null)["customer.tips"] === false);
check("a 'restaurant' row can't change a customer", customer([{ feature: "customer.tips", subject_kind: "restaurant", subject_id: ANNA, enabled: false }], ANNA)["customer.tips"] === true);
check("customer exceptions attach to a person", ROLE_SUBJECT.customer === "profile" && ROLE_LABEL.customer === "Customers");
check("pickRole hands an app its own role's switches only", Object.keys(pickRole("customer", allOn())).every((k) => k.startsWith("customer.")));
check("customer.self_pickup is locked and off", featuresFor("customer").some((f) => f.key === "customer.self_pickup" && Boolean(f.pending) && f.defaultOn === false));
check("a locked switch can't be set", src("src/lib/features/save-switch.server.ts").includes("def.pending && input.enabled !== null"));

// Each one refused by the server, hidden on the website and hidden in the app.
const CUSTOMER_WIRING: Record<string, { server: string[]; web: string[]; app: string[]; sql?: boolean }> = {
  "customer.wallet": { server: ["src/lib/data-access/wallet.ts"], web: ["src/app/(customer)/profile/page.tsx"], app: ["features/profile/profile_screen.dart"] },
  "customer.promo_codes": { server: ["src/app/api/coupons/validate/route.ts", "src/lib/data-access/orders.ts"], web: ["src/components/checkout/checkout-view.tsx"], app: ["features/checkout/checkout_screen.dart"], sql: true },
  "customer.tips": { server: ["src/lib/data-access/orders.ts"], web: ["src/components/checkout/checkout-view.tsx"], app: ["features/checkout/checkout_screen.dart"], sql: true },
  "customer.delivery_notes": { server: ["src/lib/data-access/orders.ts", "src/app/api/orders/[id]/instructions/route.ts"], web: ["src/components/checkout/checkout-view.tsx"], app: ["features/checkout/checkout_screen.dart"] },
  "customer.reorder": { server: ["src/app/api/restaurants/[slug]/menu-prices/route.ts"], web: ["src/components/orders/order-card.tsx"], app: ["features/orders/orders_screen.dart"] },
  "customer.cancel": { server: ["src/app/api/orders/[id]/cancel/route.ts", "src/lib/data-access/order-tracking.ts"], web: ["src/components/orders/tracking-view.tsx"], app: ["features/orders/tracking_screen.dart"], sql: true },
  "customer.reviews": { server: ["src/app/api/reviews/route.ts"], web: ["src/components/orders/tracking-view.tsx"], app: ["features/orders/tracking_screen.dart"], sql: true },
  "customer.rate_rider": { server: ["src/app/api/orders/[id]/rider-rating/route.ts"], web: ["src/components/orders/tracking-view.tsx"], app: ["features/orders/tracking_screen.dart"] },
  "customer.favorites": { server: ["src/app/api/favorites/route.ts"], web: ["src/components/restaurant/restaurant-actions.tsx", "src/app/(customer)/profile/page.tsx", "src/app/(customer)/profile/favorites/page.tsx"], app: ["features/restaurant/restaurant_screen.dart", "features/profile/profile_screen.dart", "state/providers.dart"], sql: true },
  "customer.saved_addresses": { server: ["src/app/api/addresses/route.ts", "src/app/api/addresses/[id]/route.ts"], web: ["src/hooks/use-saved-addresses.ts", "src/app/(customer)/profile/addresses/layout.tsx", "src/app/(customer)/profile/page.tsx"], app: ["state/providers.dart", "features/profile/profile_screen.dart", "features/location/location_screen.dart"], sql: true },
  "customer.profile_edit": { server: ["src/lib/features/guards.server.ts"], web: ["src/app/(customer)/profile/page.tsx"], app: ["features/profile/profile_screen.dart"] },
};
const constNames = src("apps/customer/lib/core/customer_features.dart");
const sql0201 = src("supabase/migrations/0201_customer_switches_in_the_database.sql");
for (const [key, w] of Object.entries(CUSTOMER_WIRING)) {
  check(`${key} is in the catalog`, keys.has(key));
  const missingServer = w.server.filter((f) => !src(f).includes(`"${key}"`));
  check(`${key} is refused by the server`, missingServer.length === 0, missingServer.join(", "));
  const missingWeb = w.web.filter((f) => !src(f).includes(`"${key}"`));
  check(`${key} is hidden on the website`, missingWeb.length === 0, missingWeb.join(", "));
  const name = constNames.match(new RegExp(`const (\\w+) = '${key.replace(".", "\\.")}'`))?.[1];
  check(`${key} has a constant in the app`, Boolean(name));
  const missingApp = w.app.filter((f) => !src(`apps/customer/lib/${f}`).includes(name ?? "@@"));
  check(`${key} is hidden in the app`, missingApp.length === 0, missingApp.join(", "));
  if (w.sql) check(`${key} holds in the database (0201)`, sql0201.includes(`'${key}'`));
}
check("every customer switch with a feature behind it is in this table",
  featuresFor("customer").every((f) => f.pending || CUSTOMER_WIRING[f.key]));
check("both profile routes check the customer switch",
  src("src/app/api/profile/route.ts").includes("customerProfileEditBlocked") && src("src/app/api/profile/avatar/route.ts").includes("customerProfileEditBlocked"));
check("/api/me sends the switches, to a guest too",
  /role: null, features/.test(src("src/app/api/me/route.ts")) && /accountStatus, features/.test(src("src/app/api/me/route.ts")));
check("the app re-reads them on resume",
  /AppLifecycleState\.resumed\) _reloadFeatures/.test(src("apps/customer/lib/app.dart")));
check("createOrder refuses, after the replay check and before anything is written", (() => {
  const s = src("src/lib/data-access/orders.ts");
  const replay = s.indexOf("A replay of an already-placed order");
  const gate = s.indexOf("new FeatureDisabledError(");
  const insert = s.indexOf('.from("orders")\n      .insert(');
  return replay > 0 && gate > replay && (insert < 0 || gate < insert);
})());
check("the order route answers a switched-off feature with 403, by name",
  /err instanceof FeatureDisabledError/.test(src("src/app/api/orders/route.ts")));
check("the role check accepts customer (0200)",
  src("supabase/migrations/0200_customer_feature_switches.sql").includes("check (role in ('customer', 'vendor', 'manager', 'driver', 'admin'))"));

// Every switch in the catalog changes something the server reads.
console.log("\nEvery switch has a reader in server code\n");
/** Keys with no reader in server code, and why that is right. */
const NO_SERVER_READER: Record<string, string> = {
  "customer.self_pickup": "No customer can choose pickup: no order field, no screen. Locked (pending) until the owner decides how they pay.",
  "driver.navigation": "Navigate only opens Google Maps on the phone, from coordinates the in-app route map needs anyway. Nothing reaches the server to refuse. Sent by /api/rider/me and hidden in the rider app and on the website.",
};
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const serverFiles = [...walk(join(ROOT, "src", "app")), ...walk(join(ROOT, "src", "lib"))].filter(
  (p) => !p.endsWith(join("features", "catalog.ts"))
);
const serverText = serverFiles.map((p) => readFileSync(p, "utf8")).join("\n");
const hasReader = (key: string) => serverText.includes(`"${key}"`);
for (const f of FEATURES) {
  const excuse = NO_SERVER_READER[f.key];
  if (excuse) continue;
  check(`${f.key} has a server reader`, hasReader(f.key));
}
for (const [key, why] of Object.entries(NO_SERVER_READER)) {
  check(`exception ${key} is in the catalog`, keys.has(key));
  check(`exception ${key} has a reason`, why.length > 20);
  check(`exception ${key} still has no reader (else drop it from the list)`, !hasReader(key));
}
check("the check really walks server code", serverFiles.some((p) => relative(ROOT, p).replace(/\\/g, "/") === "src/app/api/me/route.ts"));
check("driver.navigation is hidden in the rider app and on the website",
  src("apps/rider/lib/state/delivery.dart").includes("'driver.navigation'") && src("src/components/driver/driver-board.tsx").includes('"driver.navigation"'));

// The honesty fixes stay fixed.
console.log("\nHonest switches\n");
check("vendor.open_toggle covers hours on the store route", /openingTime[\s\S]{0,120}vendor\.open_toggle/.test(src("src/app/api/vendor/store/route.ts")));
check("...and in the web action", /openingTime[\s\S]{0,160}vendor\.open_toggle/.test(src("src/app/vendor/actions.ts")));
check("...and in the Partner app", /state\.canEdit && state\.canOpenClose/.test(src("apps/vendor/lib/features/store/store_screen.dart")));
check("vendor.reject_orders reads the order's own shop", /isFeatureOn\("vendor\.reject_orders", shopId\)/.test(src("src/app/api/orders/[id]/status/route.ts")));
check("vendor.menu_edit also stops a sheet", src("src/app/api/vendor/menu/bulk/route.ts").includes('"vendor.menu_edit"'));
check("vendor.earnings zeroes the dashboard's sales", /opts\.includeMoney \? sales/.test(src("src/lib/data-access/vendor-dashboard.ts")));
check("...and the Partner app hides the tiles", src("apps/vendor/lib/features/home/home_screen.dart").includes("if (earningsOn) _Tile("));
check("vendor.reports hides the website's charts and export", src("src/components/vendor/vendor-earnings-charts.tsx").includes('useFeature("vendor.reports")'));
check("manager.call_customer strips the rider's number: live", /canCall \? r : \{ \.\.\.r, phone: null \}/.test(src("src/app/api/manager/live/route.ts")));
check("...order detail", /manager\.call_customer"\] !== true[\s\S]{0,120}phone: null/.test(src("src/lib/ops/order-detail.ts")));
check("...exceptions", /manager\.call_customer"\] === true[\s\S]{0,120}phone: null/.test(src("src/lib/ops/rider-serialize.ts")));
check("manager.riders.view empties the Live map's riders", /canSeeRiders \?/.test(src("src/app/api/manager/live/route.ts")));
check("manager.support.manage holds on the website, emergencies excepted", /supportOn \|\| t\.priority === "emergency"/.test(src("src/app/manager/support/[id]/page.tsx")));
check("manager.exceptions.decide hides the website's buttons", src("src/components/ops/exception-queue.tsx").includes('useFeature("manager.exceptions.decide")'));

// Owner's rule: riders get a fixed salary. No switch implies anything else.
check("driver.earnings says salary", /salary/i.test(featuresFor("driver").find((f) => f.key === "driver.earnings")?.offMeans ?? "") && /salary/i.test(featuresFor("driver").find((f) => f.key === "driver.earnings")?.label ?? ""));
check("no rider switch mentions incentives, bonuses or targets",
  featuresFor("driver").every((f) => !/incentive|bonus|target/i.test(`${f.key} ${f.label} ${f.offMeans}`)));
check("the removed switches stay removed", !keys.has("driver.incentives") && !keys.has("admin.refunds"));
check("no server code reads the removed switches", !serverText.includes('"driver.incentives"') && !serverText.includes('"admin.refunds"'));

// Admin → App features.
console.log("\nThe admin page\n");
const panel = src("src/components/admin/feature-access/app-features-panel.tsx");
const nav = src("src/components/admin/admin-nav.ts");
check("the sidebar says App features", nav.includes('label: "App features"'));
check("the old URL still works, behind an admin check", /requireRole\("admin"\)/.test(src("src/app/admin/settings/feature-access/page.tsx")));
check("four sections", ["Customers", "Shops", "Riders", "Managers"].every((s) => panel.includes(`label: "${s}"`)));
check("search, group and on/off filters", ['aria-label="Search features"', 'aria-label="Group"', 'aria-label="On or off"'].every((s) => panel.includes(s)));
check("one switch at a time: no select all or bulk Turn on / Turn off", !["Select all", "Turn on", "Turn off", "saveMany", 'type="checkbox"'].some((s) => panel.includes(s)));
check("a section that can't save says so and locks its switches", /section\.blocked/.test(panel) && /disabled=\{disabled \|\| Boolean\(section\.blocked\)\}/.test(panel));
check("per account: Same as everyone / On / Off, and who changed it", ["Same as everyone", "Changed by"].every((s) => panel.includes(s)));
check("no phone chrome or cards in the panel (desktop only)", !/max-w-md|app-shell|\.device|\bcard\b/.test(panel));
const saver = src("src/lib/features/save-switch.server.ts");
check("a switch saves through the audited write", /writeOne/.test(saver) && !/saveFeatureSwitches/.test(saver) && /ops_set_feature_switch/.test(src("src/lib/features/flags.server.ts")));
const actions = src("src/app/admin/settings/feature-access/actions.ts");
check("every admin action checks the role first", (actions.match(/export async function/g) ?? []).length === (actions.match(/await requireRole\("admin"\)/g) ?? []).length);
const devActions = src("src/app/developer/features/actions.ts");
check("every developer action checks the role first", (devActions.match(/export async function/g) ?? []).length === (devActions.match(/await requireRole\("developer"\)/g) ?? []).length);
check("a customer's page has an access panel", src("src/app/admin/customers/[id]/page.tsx").includes('<AccountAccess role="customer"'));
check("a rider's and a shop's still do", src("src/app/admin/riders/[id]/page.tsx").includes("<AccountAccess") && src("src/app/admin/vendors/[id]/page.tsx").includes("<AccountAccess"));
check("the Team list links a manager to their settings", src("src/app/admin/settings/employees/page.tsx").includes("/admin/settings/feature-access?role=${e.role}&account=${e.id}"));
check("reads page past PostgREST's 1000 rows", /\.range\(page \* PAGE_SIZE/.test(src("src/lib/features/flags.server.ts")));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
