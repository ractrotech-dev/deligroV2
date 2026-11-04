/**
 * QA — the Rider, Partner and Customer app fixes of November 2026, on the server
 * side: the pure rules run, the routes are read for the gate they open with.
 * No server, no database. Usage: npx tsx --conditions=react-server scripts/qa/app-fixes-2026-11.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAction, type MachineState } from "../../src/lib/rider/delivery-machine";
import { exceptionAllowed } from "../../src/lib/rider/exception-rules";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// ---- Rider 1: a blocked rider
{
  const gate = read("src/lib/auth/rider-api.ts");
  check("the gate lets a rejected rider through only when the route asks", /opts\.allowRejected && block === "verification_rejected"/.test(gate));
  check("SOS skips the work block", /requireRiderApi\(\{ allowBlocked: true \}\)/.test(read("src/app/api/rider/sos/route.ts")));
  const me = read("src/app/api/rider/me/route.ts");
  check("/me reads the block itself, so a failed read is never 'free to work'", /allowBlocked: true/.test(me) && /riderWorkBlock\(profile\.id\)/.test(me));
  check("/me answers 403 with who to call", /status: 403/.test(me) && /contact: \{ phone: settings\.supportPhone/.test(me));
  check("/me keeps the manager's suspension reason internal", !/status_reason/.test(me));
  for (const route of [
    "src/app/api/rider/documents/route.ts",
    "src/app/api/rider/documents/[id]/url/route.ts",
    "src/app/api/rider/profile/route.ts",
  ]) {
    check(`${route} is open to a rejected rider`, /allowRejected: true/.test(route.endsWith("profile/route.ts") ? read(route).split("export async function PATCH")[0] : read(route)));
  }
  const patch = read("src/app/api/rider/profile/route.ts").split("export async function PATCH")[1];
  check("a rejected rider still can't edit the profile", !/allowRejected/.test(patch));
  check("every other rider route stays shut to a blocked rider", !/allowBlocked|allowRejected/.test(read("src/app/api/rider/status/route.ts")) && !/allowBlocked|allowRejected/.test(read("src/app/api/rider/deliveries/[orderId]/action/route.ts")));
}

// ---- Rider 2: picked up too early
{
  const s: MachineState = {
    status: "assigned",
    orderStatus: "kitchen",
    arrivedPickupAt: "2026-11-04T10:00:00Z",
    departedPickupAt: null,
    arrivedDropAt: null,
  };
  check("pickup during cooking is food_not_ready", JSON.stringify(checkAction(s, "pickup")) === JSON.stringify({ ok: false, error: "food_not_ready" }), checkAction(s, "pickup"));
  check("...on a placed order too", (checkAction({ ...s, orderStatus: "placed" }, "pickup") as { error?: string }).error === "food_not_ready");
  check("a cancelled order is still gone", (checkAction({ ...s, orderStatus: "cancelled" }, "pickup") as { error?: string }).error === "order_not_active");
  check("a pickup when ready still goes", checkAction({ ...s, orderStatus: "ready" }, "pickup").ok);
  check("the web board has its own words", /food_not_ready/.test(read("src/components/driver/driver-board.tsx")));
}

// ---- Rider 4: a report's photo before the pickup
{
  const src = read("src/lib/data-access/rider-delivery-actions.ts");
  const fn = src.slice(src.indexOf("export async function uploadDeliveryProof"));
  check("the upload takes a photo at assigned", /row\.status !== "picked_up" && row\.status !== "assigned"/.test(fn));
  check("...and returns before it could count as proof of delivery", fn.indexOf('row.status === "assigned") return { ok: true, path }') > 0 && fn.indexOf('row.status === "assigned") return { ok: true, path }') < fn.indexOf("pod_photo_path: path"));
  const ex = read("src/lib/data-access/delivery-exceptions.ts");
  check("a report's photo must be in this delivery's own folder", /input\.photoPath\.startsWith\(`\$\{row\.id\}\/`\)/.test(ex));
  check("...and really stored, only before the pickup", /state === "assigned" && \(await proofFileExists/.test(ex));
}

// ---- Rider 5: customer unreachable with nobody to call
{
  const T0 = Date.parse("2026-11-04T10:00:00Z");
  const ctx = { now: T0 + 11 * 60_000, arrivedDropAt: new Date(T0).toISOString(), lastCustomerCallAt: null, unreachableWaitMinutes: 10 };
  check("able to call: the call comes first", (exceptionAllowed("customer_unreachable", "picked_up", ctx) as { error?: string }).error === "call_first");
  check("unset is able to call", (exceptionAllowed("customer_unreachable", "picked_up", { ...ctx, customerCallable: undefined }) as { error?: string }).error === "call_first");
  check("unable to call: it opens", exceptionAllowed("customer_unreachable", "picked_up", { ...ctx, customerCallable: false }).ok);
  check("unable to call: the wait still applies", (exceptionAllowed("customer_unreachable", "picked_up", { ...ctx, now: T0 + 60_000, customerCallable: false }) as { error?: string }).error === "wait_longer");
  check("unable to call: not before the door", (exceptionAllowed("customer_unreachable", "picked_up", { ...ctx, arrivedDropAt: null, customerCallable: false }) as { error?: string }).error === "bad_state");
  const ex = read("src/lib/data-access/delivery-exceptions.ts");
  check("the server reads the switch and the number", /isFeatureOn\("driver\.call_customer", driverId\)/.test(ex) && /activeCustomerPhone\(supabase, orderId\)/.test(ex));
}

// ---- Partner 7: the cash rule
{
  check("the statement says the rider collects cash for Deligro", /rider collects the cash for Deligro/.test(read("apps/vendor/lib/core/documents.dart")));
  for (const f of ["apps/vendor/lib/core/documents.dart", "apps/vendor/lib/models/money.dart", "src/app/api/vendor/payments/route.ts"]) {
    check(`${f} no longer says the shop keeps the cash`, !/already holds the money|cash the shop kept|cash it kept/.test(read(f)));
  }
}

// ---- Partner 8: links the app has pages for
{
  const router = read("apps/vendor/lib/router.dart");
  const urls = [
    ...read("src/lib/data-access/manager-vendor-actions.ts").matchAll(/, "(\/[^"]+)"\)\);/g),
    ...read("src/lib/data-access/bulk-menu.ts").matchAll(/\}, "(\/[^"]+)"\)/g),
  ].map((m) => m[1]);
  check("the vendor actions and bulk menu send links", urls.length >= 4, urls);
  for (const u of urls) {
    const page = u.split("/").pop() as string;
    check(`${u} is a page in the app`, new RegExp(`path: '${page}'`).test(router), u);
  }
  const product = read("src/lib/data-access/manager-product-actions.ts");
  check("dish links name the app's page", !/`\/menu\//.test(product) && /`\/more\/products\/\$\{id\}`/.test(product));
  check("the router has a friendly error page", /errorBuilder: \(_, _\) => const NotFoundScreen\(\)/.test(router));
  check("a /payments push is honoured", /\^\/payments\$/.test(read("apps/vendor/lib/core/push.dart")));
}

// ---- Partner 10 + 11 + 13
{
  check("export follows the import switch", /GET[\s\S]*vendorFeatureContext\("vendor\.menu_import"\)/.test(read("src/app/api/vendor/menu/bulk/route.ts")));
  const json = read("src/lib/vendor/menu-json.ts");
  for (const k of ["approvalStatus", "pendingPrice", "hidden", "hiddenReason", "approvalNote"]) {
    check(`the app's menu carries ${k}`, new RegExp(`\\b${k}: m\\.${k}`).test(json));
  }
  check("the dashboard counts what Accept leaves", /outForDelivery: all\.filter\(\(o\) => o\.status === "on_the_way"\)/.test(read("src/lib/data-access/vendor-dashboard.ts")));
}

// ---- Customer 14 + 17
{
  const orders = read("src/lib/data-access/orders.ts");
  check("orders read the dish's id", /menu_items\(id, external_id, veg\)/.test(orders) && !/menu_items\(external_id, veg\)/.test(orders));
  check("the website's Order again has it too", /menuItem\?\.external_id \?\? menuItem\?\.id \?\? item\.name/.test(read("src/lib/utils/order-map.ts")));
  const check17 = orders.indexOf("input.expectedTotal !== payable");
  check("a changed total is refused before anything is written", check17 > 0 && check17 < orders.indexOf("const insertOrder = ("));
  check("expectedTotal never prices anything", (orders.match(/expectedTotal/g) ?? []).length === 3, (orders.match(/expectedTotal/g) ?? []).length);
  const route = read("src/app/api/orders/route.ts");
  check("the route answers 409 total_changed with the bill", /error: "total_changed", bill: err\.bill/.test(route) && /status: 409/.test(route));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
