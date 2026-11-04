/**
 * The delivery radius has one home: Delivery radius and zones.
 *
 * What this guards: moving the field off the Platform settings form is only safe
 * while that form's save carries the stored value through. Reading the absent
 * field would fall back to a default on every save, and quietly change where
 * customers can order.
 */
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(f, "utf8");
let failed = 0;
function ok(label: string, pass: boolean) {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
  if (!pass) failed += 1;
}

const form = read("src/app/admin/settings/settings-form.tsx");
const actions = read("src/app/admin/settings/actions.ts");
const zonesPage = read("src/app/admin/settings/zones/page.tsx");
const manager = read("src/app/admin/settings/zones/zones-manager.tsx");
const nav = read("src/components/admin/admin-nav.ts");

ok("Platform settings has no delivery radius field", !/name="deliveryRadiusKm"/.test(form));
ok("a Platform settings save keeps the stored radius", /deliveryRadiusKm:\s*current\.deliveryRadiusKm/.test(actions));
ok("...and never reads it from the form", !/form\.get\("deliveryRadiusKm"\)/.test(actions));

const action = actions.slice(actions.indexOf("export async function saveDeliveryRadiusAction"));
const body = action.slice(0, action.indexOf("\n}\n"));
ok("the radius action starts with an admin check", /Promise<ActionResult> \{\s*const admin = await requireRole\("admin"\);/.test(body));
ok("the radius action is rate-limited", /rateLimit\(`delivery-radius:\$\{admin\.id\}`/.test(body));
ok("a bad radius is refused, not clamped", /radiusKm > 200/.test(body) && !/Math\.(min|max)/.test(body));

ok("the page checks the role itself", zonesPage.includes(`await requireRole("admin")`));
ok("a settings outage shows no made-up radius", /source === "unavailable" \? null/.test(zonesPage));
ok("the page says zones don't limit delivery", manager.includes("A zone doesn't change where customers can order"));
ok("the sidebar uses the new name", nav.includes(`label: "Delivery radius and zones"`));
ok("the zone list is a real table, with no breakpoints", manager.includes("<DataTable") && !/\b(sm|md|lg|xl|@\dxl):/.test(manager));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
