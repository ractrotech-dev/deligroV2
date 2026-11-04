/**
 * QA — the admin console's shop, people, banner and settings fixes.
 *
 * Pure logic is run directly; the wiring (who calls what, what a screen offers) is
 * read from the source files, the same way platform-separation.ts works. Offline:
 * no database and no server.
 *
 * Usage: npm run test:admin-fixes
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_PLACEMENTS, LIVE_TARGETS, bannerShowsAnywhere, campaignPlacements, isLiveTarget, targetNeedsValue } from "../../src/lib/banner-placements";
import { bannerHref } from "../../src/lib/banner-href";
import { staffAccessMessage, staffAccessRefusal, staffPasswordRefusal, staffRemovalRefusal, validStaffReason } from "../../src/lib/auth/staff-access";
import { hideMasterAccounts } from "../../src/lib/developers";
import { shopPlaceFrom } from "../../src/lib/maps/shop-place";
import { FEATURES } from "../../src/lib/features/catalog";
import { LISTED_ALERT_KINDS } from "../../src/lib/ops/alerts/catalog";
import { parseRuleBody } from "../../src/lib/ops/alerts-contract";
import { AUDIT_ACTIONS } from "../../src/lib/ops/audit-catalog";
import { auditPager } from "../../src/lib/ops/audit-paging";
import { validateCampaignInput } from "../../src/lib/marketing/campaign-rules";
import { istInputToIso, isoToIstLocal } from "../../src/lib/utils/ist-time";
import { canMoveMarketing, marketingMoves, MARKETING_STATUSES } from "../../src/lib/vendor/growth-input";
import { vendorEditAudit } from "../../src/lib/vendors/edit-audit";
import { ownerAccountOutcome } from "../../src/lib/vendors/owner-account";
import { VendorEditRefused, assertKeepsPin, parsePin } from "../../src/lib/vendors/readiness";
import { ADMIN_NAV, ADMIN_NAV_GROUPS, activeNavItem } from "../../src/components/admin/admin-nav";
import type { Banner, BannerTargetType } from "../../src/types";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : `\n         ${JSON.stringify(detail)}`}`);
  }
}

const src = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");

console.log("\n1. deleting a shop keeps accounts that are not purely a vendor login");
const facts = { role: "restaurant", otherShops: 0, customerOrders: 0, addresses: 0 };
check("a pure vendor login is removed", ownerAccountOutcome(facts) === "remove_login");
check("a 'stay both' customer keeps their account", ownerAccountOutcome({ ...facts, role: "customer" }) === "keep_login");
check("an owner of another shop keeps it", ownerAccountOutcome({ ...facts, otherShops: 1 }) === "keep_login");
check("a vendor login with orders becomes a customer", ownerAccountOutcome({ ...facts, customerOrders: 2 }) === "make_customer");
check("a vendor login with a saved address becomes a customer", ownerAccountOutcome({ ...facts, addresses: 1 }) === "make_customer");
check("no profile is never a delete", ownerAccountOutcome({ ...facts, role: null }) === "keep_login");
for (const role of ["admin", "manager", "driver"]) check(`a ${role} is never deleted`, ownerAccountOutcome({ ...facts, role }) === "keep_login");
const vendors = src("src/lib/data-access/admin-vendors.ts");
check("deleteVendor decides before it deletes anything",
  vendors.indexOf("ownerAccountOutcome(await readOwnerFacts") < vendors.indexOf('.from("restaurants").delete()'));
check("deleteVendor's account delete has its error handled",
  /const \{ error: ownerError \} =[\s\S]{0,120}deleteUser\(ownerId\)/.test(vendors) && vendors.includes("if (ownerError)"));

console.log("\n2. map pin on the edit page");
check("both blank is no pin", (() => { const p = parsePin("", " "); return p.ok && p.lat === null && p.lng === null; })());
check("a real pin parses", (() => { const p = parsePin("21.71", "81.53"); return p.ok && p.lat === 21.71 && p.lng === 81.53; })());
check("half a pin is refused", !parsePin("21.71", "").ok && !parsePin("", "81.53").ok);
check("text is refused", !parsePin("abc", "81.53").ok);
check("swapped numbers are refused", !parsePin("81.53", "21.71").ok);
check("0, 0 is refused", !parsePin("0", "0").ok);
check("a non-text field counts as blank", (() => { const p = parsePin(null, undefined); return p.ok && p.lat === null; })());
const refused = (fn: () => void) => { try { fn(); return false; } catch (e) { return e instanceof VendorEditRefused; } };
check("a live shop can't lose its pin", refused(() => assertKeepsPin("active", { lat: 21, lng: 81 }, { lat: null, lng: null })));
check("a live shop that never had one stays editable", !refused(() => assertKeepsPin("active", { lat: null, lng: null }, { lat: null, lng: null })));
check("a disabled shop can lose it", !refused(() => assertKeepsPin("inactive", { lat: 21, lng: 81 }, { lat: null, lng: null })));
const form = src("src/app/admin/vendors/[id]/edit/vendor-form.tsx");
check("the edit form reuses the map picker", form.includes("<MapPicker"));
check("the location's own button saves through its own action", form.includes("saveVendorLocationAction(vendor.id, place)"));
const vendorActions = src("src/app/admin/vendors/actions.ts");
const locationAction = vendorActions.slice(vendorActions.indexOf("export async function saveVendorLocationAction"));
check("saving a location opens with its own requireRole", /Promise<ActionResult> \{\s*const admin = await requireRole\("admin"\)/.test(locationAction));
check("saving a location is rate-limited and checks the pin", locationAction.includes("vendor-location:") && locationAction.includes("parsePin("));
const vendorData = src("src/lib/data-access/admin-vendors.ts");
const locationWrite = vendorData.slice(vendorData.indexOf("export async function updateVendorLocation"), vendorData.indexOf("export async function setVendorOpen"));
check("saving a location keeps the pin rule, the area rule and the audit entry", locationWrite.includes("assertKeepsPin(") && locationWrite.includes("assertZoneUsable(") && locationWrite.includes("auditedChange("));
check("the edit page is wide: no phone chrome or breakpoints", !/\b(sm|md|lg|xl|@\dxl):/.test(form) && !form.includes("action-dock") && !src("src/app/admin/vendors/[id]/edit/page.tsx").includes("admin-measure"));
check("the edit form has latitude, longitude and a photo", form.includes('name="lat"') && form.includes('name="lng"') && form.includes('name="imageUrl"'));
check("the old 'set it in the wizard' line is gone", !form.includes("registration wizard"));
const overview = src("src/app/admin/vendors/[id]/vendor-overview.tsx");
check("'Fix' goes to the pin or the photo on the edit page", overview.includes("#pin") && overview.includes("#photo") && !overview.includes("Fix on edit"));
check("the wizard and the edit page share one photo upload",
  src("src/app/admin/vendors/new/registration-wizard.tsx").includes("ShopPhotoUpload") && form.includes("ShopPhotoUpload"));

console.log("\n3. area on the edit page");
check("the edit form has an Area choice", form.includes('name="zoneId"') && form.includes('label="Area"'));
check("the form says what happens to existing orders", /Orders already placed stay/.test(form));
check("moving a shop checks the zone is on", vendors.includes("assertZoneUsable"));

console.log("\n4. stop, start again, reset password");
const manager = { id: "m", role: "manager", accountStatus: "active" };
const rider = { id: "r", role: "driver", accountStatus: "active" };
check("an active manager can be stopped", staffAccessRefusal("a", manager, "stop") === null);
check("an active rider can be stopped", staffAccessRefusal("a", rider, "stop") === null);
check("you can't stop yourself", staffAccessRefusal("m", manager, "stop") === "self");
check("no admin can be stopped, so never the last one", staffAccessRefusal("a", { id: "b", role: "admin", accountStatus: "active" }, "stop") === "admin");
check("a customer can't be stopped from here", staffAccessRefusal("a", { id: "c", role: "customer", accountStatus: "active" }, "stop") === "not_staff");
check("stopping twice is refused", staffAccessRefusal("a", { ...manager, accountStatus: "suspended" }, "stop") === "already");
check("a stopped manager can start again", staffAccessRefusal("a", { ...manager, accountStatus: "suspended" }, "start") === null);
check("starting someone active is refused", staffAccessRefusal("a", manager, "start") === "already");
check("no such person", staffAccessRefusal("a", null, "stop") === "not_found");
const gone = { ...manager, accountStatus: "suspended", removed: true };
check("a removed person can't be activated again from here", staffAccessRefusal("a", gone, "start") === "removed");
check("a removed person can't get a new password", staffPasswordRefusal("a", gone) === "removed");
check("the cash refusal says what to do", staffAccessMessage("cash_held").includes("Cash & expenses"));
check("a stopped person can still get a new password", staffPasswordRefusal("a", { ...rider, accountStatus: "suspended" }) === null);
check("no resetting your own or an admin's password here",
  staffPasswordRefusal("m", manager) === "self");
const otherAdmin = { id: "b", role: "admin", accountStatus: "active" };
check("another admin's password can be reset", staffPasswordRefusal("a", otherAdmin) === null);
check("the master account's can't, and it reads as not found", staffPasswordRefusal("a", { ...otherAdmin, master: true }) === "not_found");
check("the master account can't be stopped either", staffAccessRefusal("a", { ...otherAdmin, master: true }, "stop") === "not_found");
check("an admin still can't be removed", staffRemovalRefusal("a", otherAdmin) === "admin");
check("the master account is left off a list by its phone",
  hideMasterAccounts([{ phone: "+91 79872 65706" }, { phone: "+919999999999" }, { phone: null }]).length === 2);
for (const [file, label] of [["employees", "Team"], ["rider-cash", "the rider's deposit list"], ["manager-tickets", "the ticket assignees"]]) {
  check(`${label} leaves out the master account`, src(`src/lib/data-access/${file}.ts`).includes("hideMasterAccounts("));
}
check("a reason is needed", !validStaffReason("  a ") && validStaffReason("left the company") && !validStaffReason("x".repeat(301)));
check("the on-delivery refusal is said plainly", staffAccessMessage("active_delivery").includes("on a delivery"));
const empActions = src("src/app/admin/settings/employees/actions.ts");
for (const fn of ["stopStaffAction", "startStaffAction", "resetStaffPasswordAction", "removeStaffAction"]) {
  check(`${fn} opens with its own requireRole`,
    new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\s*const admin = await requireRole\\("admin"\\)`).test(empActions));
}
const access = src("src/lib/data-access/staff-access.ts");
check("a rider goes through the audited rider action", access.includes("actOnRider("));
check("a manager is banned, set by the RPC, and signed out", access.includes("setAuthBan(") && access.includes("ops_admin_set_staff_account") && access.includes("ops_revoke_staff_sessions"));
check("a new password is not stored", !access.includes("storeVendorCredential"));
check("requireRole refuses a stopped manager", src("src/lib/auth.ts").includes('profile.role === "manager" && (await staffAccountStopped'));
check("the manager API refuses a stopped manager", src("src/lib/auth/manager-api.server.ts").includes("account_suspended"));
const sql = src("supabase/migrations/0190_admin_staff_access.sql");
check("0190 refuses yourself and anyone but a manager", sql.includes("p_user = p_actor") && sql.includes("role_name is distinct from 'manager'"));
check("0190's functions are service role only",
  /revoke execute on function public\.ops_admin_set_staff_account[^;]*from public, anon, authenticated/.test(sql) &&
  /revoke execute on function public\.ops_revoke_staff_sessions[^;]*from public, anon, authenticated/.test(sql));
check("0190: a stopped manager is not a manager to RLS", /role = 'manager' and account_status = 'active'/.test(sql));
check("the Team page and the rider page have the controls",
  src("src/app/admin/settings/employees/page.tsx").includes("<StaffAccessControls") && src("src/app/admin/riders/[id]/page.tsx").includes("<StaffAccessControls"));
check("the Team page shows the login, read behind its admin check", src("src/app/admin/settings/employees/page.tsx").includes("listStaffLoginEmails(staffIds)"));
check("the promo code read names which shop link it means", src("src/lib/data-access/promotions.ts").includes("restaurants!coupons_restaurant_id_fkey"));
check("no staff password is kept or shown", !src("src/lib/data-access/employees.ts").includes("storeVendorCredential") && !src("src/app/admin/settings/employees/page.tsx").includes("loginPassword"));
check("the rider page no longer sends people to Team to suspend", !src("src/app/admin/riders/[id]/profile-tab.tsx").includes("suspended from Team"));

console.log("\n5. open / closed from Admin");
const shopPage = src("src/app/admin/vendors/[id]/page.tsx");
check("the shop page has the control", shopPage.includes("<VendorOpenButton"));
check("the action opens with its own requireRole",
  /export async function setVendorOpenAction\([^)]*\)[^{]*\{\s*const admin = await requireRole\("admin"\)/.test(src("src/app/admin/vendors/actions.ts")));
check("it clears a timed close", vendors.includes("closed_until: null"));

console.log("\n6. credentials and contact details");
check("credentials live on one tab only",
  shopPage.includes("<VendorCredentials") && !overview.includes("VendorCredentials") && !src("src/app/admin/vendors/[id]/edit/page.tsx").includes("VendorCredentials"));
check("the form says these are contact details", form.includes('label="Contact mobile"') && form.includes('label="Contact email"') && form.includes("does not change how they sign in"));
check("the panel shows the real login", shopPage.includes("getVendorLogin(") && vendors.includes("auth.admin.getUserById"));

console.log("\n7. banners");
const banner = (placements: string[], type: BannerTargetType = "food", value?: string) =>
  ({ placements, target: { type, value } }) as unknown as Banner;
check("only the home carousel is offered", LIVE_PLACEMENTS.length === 1 && LIVE_PLACEMENTS[0] === "home_hero");
check("a home banner shows", bannerShowsAnywhere(["home_hero"]) && bannerShowsAnywhere(["checkout", "home_hero"]));
check("dead placements don't", !bannerShowsAnywhere(["home_food"]) && !bannerShowsAnywhere(["home_top"]) && !bannerShowsAnywhere([]) && !bannerShowsAnywhere(null));
check("a campaign with nothing readable lands on the home carousel",
  campaignPlacements(undefined)[0] === "home_hero" && campaignPlacements(["home_top"])[0] === "home_hero" && campaignPlacements([])[0] === "home_hero");
const campaign = (placements?: unknown) => validateCampaignInput({
  kind: "banner", title: "Diwali deal", zoneId: "11111111-1111-1111-1111-111111111111",
  startsAt: "2031-01-01T00:00:00.000Z", endsAt: "2031-01-05T00:00:00.000Z", budget: null, fundedBy: "deligro", vendorSharePct: null, slotPosition: null,
  banner: { headline: "Hi", description: "", ctaLabel: "Go", targetType: "food", placements },
}, new Date("2030-01-01T00:00:00Z"));
for (const [label, value] of [["home_top from the Manager app", ["home_top"]], ["no placement", undefined]] as const) {
  const r = campaign(value);
  check(`a campaign with ${label} is stored on home_hero`, r.ok && r.value.banner?.placements[0] === "home_hero", r);
}
check("nothing in the rules defaults to home_top any more", !src("src/lib/marketing/campaign-rules.ts").includes('["home_top"]'));
for (const dead of ["membership", "refer", "product", "store"]) check(`${dead} is not offered`, !isLiveTarget(dead));
check("pharmacy stays offered: it works on the website", isLiveTarget("pharmacy") && bannerHref(banner(["home_hero"], "pharmacy")) === "/stores?category=pharmacy");
for (const t of LIVE_TARGETS) check(`${t.id} leads somewhere on the website`, bannerHref(banner(["home_hero"], t.id, "x")) !== "");
const dart = src("apps/customer/lib/models/banner.dart");
for (const t of LIVE_TARGETS.filter((x) => x.id !== "pharmacy")) check(`${t.id} has a route in the customer app`, dart.includes(`case '${t.id}':`));
for (const t of ["restaurant", "category", "external"]) check(`${t} asks for a value`, targetNeedsValue(t));
check("a section link doesn't ask for one", !targetNeedsValue("food"));
for (const dead of ["membership", "refer", "product", "store"] as const) {
  const href = bannerHref(banner(["home_hero"], dead, "x"));
  check(`an old ${dead} banner no longer links to a missing page`, !/profile\/|\/product\/|\/stores\/x/.test(href), href);
}
const bannerForm = src("src/app/admin/banners/banner-form.tsx");
for (const gone of ["targetCities", "targetZones", "targetSegments"]) check(`the form no longer asks for ${gone}`, !bannerForm.includes(gone));
const bannerData = src("src/lib/data-access/banners.ts");
check("saving without targeting leaves the columns alone", bannerData.includes("...(input.targetCities ? { target_cities"));
const bannerPage = src("src/app/admin/banners/campaigns-view.tsx");
check("the list marks what shows nowhere", bannerPage.includes("Not showing anywhere"));
check("the campaign figures sit above the cards", bannerPage.indexOf("<MetricRow") > 0 && bannerPage.indexOf("<MetricRow") < bannerPage.indexOf("<CampaignCard"));
check("the always-zero Orders figure is gone", !bannerPage.includes("Attributed orders") && !bannerPage.includes('label="Orders"'));

console.log("\n8. India time");
check("typed India time is the right instant", istInputToIso("2030-01-05T09:30") === "2030-01-05T04:00:00.000Z");
check("blank and rubbish are null", istInputToIso("") === null && istInputToIso("soon") === null && istInputToIso(null) === null);
check("shown back in India time", isoToIstLocal("2030-01-05T04:00:00.000Z") === "2030-01-05T09:30");
check("blank shows blank", isoToIstLocal(null) === "" && isoToIstLocal("nonsense") === "");
let stored = "2030-03-09T18:45:00.000Z";
for (let i = 0; i < 5; i++) stored = istInputToIso(isoToIstLocal(stored))!;
check("re-saving five times doesn't move it", stored === "2030-03-09T18:45:00.000Z", stored);
check("right after midnight India time", isoToIstLocal("2030-06-30T18:30:00.000Z") === "2030-07-01T00:00");
for (const f of ["src/app/admin/banners/actions.ts", "src/app/admin/coupons/actions.ts", "src/app/vendor/promotions/actions.ts"]) {
  const s = src(f);
  check(`${f} parses as India time`, s.includes("istInputToIso(") && !/new Date\(raw\)/.test(s));
}
check("the coupon form shows India time", src("src/components/promotions/promotion-form.tsx").includes("isoToIstLocal("));

console.log("\n9. marketing requests");
const decision = src("src/app/admin/marketing/decision-form.tsx");
check("the form offers exactly the server's moves", decision.includes("marketingMoves(status)") && !/in_progress: \[\s*\{/.test(decision));
for (const from of MARKETING_STATUSES) {
  check(`every move offered from ${from} is allowed`, marketingMoves(from).every((to) => canMoveMarketing(from, to)));
}
check("approving says it creates no campaign", decision.includes("does not create a campaign"));

console.log("\n10. feature switches (more in role-features.ts)");
check("driver.cod_change stays (owner decision)", FEATURES.some((f) => (f.key as string) === "driver.cod_change"));
check("driver.navigation is untouched", FEATURES.some((f) => (f.key as string) === "driver.navigation"));

console.log("\n11. alert rules");
check("fraud and service-level rules are not listed", !LISTED_ALERT_KINDS.some((k) => k.kind === "fraud_suspected" || k.kind === "sla_breach"));
check("the rest are", LISTED_ALERT_KINDS.some((k) => k.kind === "order_unassigned"));
check("a rule list reads the listed kinds", src("src/lib/data-access/manager-alerts.ts").includes("LISTED_ALERT_KINDS.map"));
const fraudRule = parseRuleBody({ kind: "fraud_suspected", zoneId: null, enabled: true, threshold: null, windowMinutes: null, clientActionId: "11111111-1111-1111-1111-111111111111" });
check("a write can't switch one on", !fraudRule.ok, fraudRule);
const rulesFixture = JSON.parse(src("apps/manager/test/fixtures/api/generated/phase8/alert_rules.json")) as { rules: { kind: string }[] };
check("the Manager app's fixture matches", rulesFixture.rules.length > 0 && !rulesFixture.rules.some((r) => r.kind === "fraud_suspected" || r.kind === "sla_breach"));
check("the thresholds page highlights Alerts", activeNavItem("/admin/settings/alerts")?.href === "/admin/alerts", activeNavItem("/admin/settings/alerts")?.href);
check("other settings pages still highlight Settings", activeNavItem("/admin/settings")?.href === "/admin/settings");
check("Team still highlights Team", activeNavItem("/admin/settings/employees")?.href === "/admin/settings/employees");

console.log("\n12. customer search");
const customers = src("src/lib/data-access/admin-customers.ts");
check("search runs in the database", customers.includes(".or(`full_name.ilike.${needle},phone.ilike.${needle}`)") && customers.includes(".range(from, from + pageSize - 1)"));
const customersPage = src("src/app/admin/customers/page.tsx");
check("the page no longer loads a fixed window", !customersPage.includes("WINDOW") && !customersPage.includes("c.name.toLowerCase()"));
check("the page has real paging", customersPage.includes("totalPages={totalPages}"));
check("every customer figure stays on the page", ["New this week", "Have ordered", "Avg orders"].every((f) => customersPage.includes(`label="${f}"`)));
// customerSearchNeedle lives in a server-only module, so its rule is read from the source.
check("search text can't break out of the filter", customers.includes('.replace(/[,()%*\\\\"]/g, " ")'));

console.log("\n13. audit log");
const CUR = (n: number) => `cur${n}`;
const p1 = auditPager("/admin/audit", new URLSearchParams("zone=z"), CUR(1));
check("page 1 has Next but no Back", p1.back === null && p1.page === 1 && p1.next === "/admin/audit?zone=z&cursor=cur1");
const p2 = auditPager("/admin/audit", new URLSearchParams("zone=z&cursor=cur1"), CUR(2));
check("page 2's Back returns to the start", p2.back === "/admin/audit?zone=z" && p2.page === 2);
check("page 2's Next remembers where it came from", p2.next === "/admin/audit?zone=z&cursor=cur2&back=cur1", p2.next);
const p3 = auditPager("/admin/audit", new URLSearchParams("zone=z&cursor=cur2&back=cur1"), null);
check("page 3's Back goes to page 2", p3.back === "/admin/audit?zone=z&cursor=cur1" && p3.page === 3, p3);
check("the last page has no Next", p3.next === null);
check("a tampered trail is dropped", !auditPager("/admin/audit", new URLSearchParams("cursor=cur2&back=evil%3Cscript%3E"), null).back?.includes("evil"));
const auditPage = src("src/app/admin/audit/page.tsx");
check("the audit page uses them", auditPage.includes("auditPager(") && auditPage.includes("nextCursor = page.nextCursor"));
check("paging doesn't count as filtering", auditPage.includes('k !== "cursor" && k !== "back"'));
const edit = vendorEditAudit(
  { commission_pct: "10", bank_account_number: "1234", owner_mobile: "+919876543210", opening_time: "09:00:00", name: "A" },
  { commission_pct: 12, bank_account_number: "5678", owner_mobile: "+919876543210", opening_time: "09:00", name: "A" }
);
check("a commission change is logged with its values", edit.before.commission_pct === "10" && edit.after.commission_pct === 12);
check("a bank change is named, its number is not written", JSON.stringify(edit).includes("bank_account_number") && !JSON.stringify(edit).includes("5678") && !JSON.stringify(edit).includes("1234"));
check("what didn't change isn't logged", !JSON.stringify(edit).includes("owner_mobile") && !("opening_time" in edit.after) && !("name" in edit.after));
check("a save that changes nothing logs nothing", vendorEditAudit({ name: "A" }, { name: "A" }).empty);
const codes = new Set(AUDIT_ACTIONS.map((a) => a.code));
for (const c of ["vendor.edit", "vendor.delete", "vendor.open_set", "banner.create", "banner.update", "banner.status", "banner.delete", "category.create", "category.update", "category.enable", "category.delete", "category.image", "offer.delete", "staff.stop", "staff.start", "staff.password_reset"]) {
  check(`${c} has a label on the audit screen`, codes.has(c));
}
check("audit entries keep the log-first order", /await logOpsAction\(entry\);\s*try \{/.test(src("src/lib/data-access/ops-audit.ts")));

console.log("\n14-16. small ones");
const catForm = src("src/app/admin/settings/categories/categories-form.tsx");
check("Reset posts its own field, not a second imageUrl", catForm.includes('name="reset"') && (catForm.match(/name="imageUrl"/g) ?? []).length === 1);
check("the action honours it", src("src/app/admin/settings/categories/actions.ts").includes('form.get("reset") ? ""'));
const storage = src("src/app/admin/storage/page.tsx");
check("the storage tab's class keeps its space", storage.includes('transition-colors " +') && !storage.includes('transition-colors" +'));
const announce = src("src/app/admin/announcements/announcement-form.tsx");
check("a sent announcement clears the form", announce.includes("if (result.ok)") && announce.includes('setTitle("")') && announce.includes('setBody("")') && announce.includes("formRef.current?.reset()"));
check("the button is off while sending", announce.includes("disabled={pending}"));
check("the same message can't go out twice in a minute", src("src/app/admin/announcements/actions.ts").includes("admin-announcement-once:"));

console.log("\n17. vendor list and shop page");
const list = src("src/app/admin/vendors/page.tsx");
check("there is no approvals or rejected tab", !list.includes('label: "Approvals"') && !list.includes('label: "Rejected"'));
check("no figure counts only the loaded page", !list.includes("result.items.filter"));
check("both figures come from the database", list.includes("counts.incomplete") && list.includes("counts.noEmail"));
{
  const rowActions = src("src/app/admin/vendors/vendor-row-actions.tsx");
  const bar = src("src/app/admin/vendors/vendor-search-bar.tsx");
  const pwCell = src("src/app/admin/vendors/vendor-password-cell.tsx");
  const master = src("src/app/admin/vendors/vendor-master-switch.tsx");
  const vendorData = src("src/lib/data-access/admin-vendors.ts");
  const bulk = vendorData.slice(vendorData.indexOf("export async function setAllVendorsStatus"), vendorData.indexOf("export interface DeleteVendorResult"));
  const bulkAction = src("src/app/admin/vendors/actions.ts");
  check("the on/off switch is the last column, with the master switch above it", list.includes("<VendorStatusToggle") && list.includes("<VendorMasterSwitch") && list.indexOf('key: "enabled"') > list.indexOf('key: "actions"'));
  check("feed slot and orders columns are gone, the star stays", !list.includes('key: "slot"') && !list.includes('key: "orders"') && list.includes("<Star"));
  check("the password cell has one reset button and hides copy until shown", pwCell.includes("Reset password") && !pwCell.includes("RefreshCw") && pwCell.includes("{shown ? (\n        <button"));
  const access = src("src/app/admin/vendors/[id]/vendor-credentials.tsx");
  const rows = src("src/app/admin/vendors/vendor-row-actions.tsx");
  check("password reset is one button everywhere", pwCell.includes("<VendorPasswordDialog") && access.includes("<VendorPasswordDialog") && !access.includes("resetVendorPasswordAction") && !pwCell.includes("resetVendorPasswordAction") && !src("src/app/admin/vendors/vendor-password-dialog.tsx").includes("Generate one"));
  check("vendor row buttons match the rider buttons", rows.includes("c-btn c-btn-outline") && rows.includes("border border-deal/40 text-deal") && !rows.includes("lucide-react"));
  check("the master switch asks for a reason", master.includes("reason.trim().length < 3"));
  check("the master action checks the role, a reason and a rate limit", /setAllVendorsStatusAction[\s\S]{0,200}requireRole\("admin"\)/.test(bulkAction) && bulkAction.includes("vendors-master-switch:"));
  check("the master switch skips suspended and unpinned shops", bulk.includes('.eq("status", "active")') && bulk.includes('.eq("status", "inactive").not("lat", "is", null).not("lng", "is", null)') && !bulk.includes("suspended\""));
  check("each shop goes through the audited function", bulk.includes('"ops_admin_set_vendor_status"') && !bulk.includes(".update("));
  check("the switch asks for a recorded reason", rowActions.includes("useStatusToggle") && rowActions.includes("setVendorStatusAction"));
  check("the filters are one panel with removable chips", bar.includes('role="dialog"') && bar.includes("Remove the ${group.label} filter"));
  check("filter values from the URL are allow-listed", list.includes("pickFilter(VENDOR_GAPS") && list.includes("pickFilter(VENDOR_RATES") && list.includes("pickFilter(VENDOR_OPEN_STATES"));
}
check("the Activity tab reads the audit log", shopPage.includes('entityType: "vendor", entityId: v.id') && !shopPage.includes("arrives in a later phase"));
check("the categories page tells the truth", !src("src/app/admin/vendors/categories/page.tsx").includes("customer feed") && !list.includes("Group shops on the customer feed"));

{
  const at = (lat: number, lng: number) => ({ lat: () => lat, lng: () => lng }) as google.maps.LatLng;
  const shop = shopPlaceFrom({
    name: "Sharma Sweets",
    formatted_address: "Main Road, Ambikapur 497001",
    geometry: { location: at(23.12, 83.19) },
    address_components: [{ long_name: "497001", short_name: "497001", types: ["postal_code"] }],
  });
  check("a Google place gives the form its address, pin and pincode", shop?.address === "Main Road, Ambikapur 497001" && shop.lat === 23.12 && shop.lng === 83.19 && shop.pincode === "497001");
  check("typed text with no position is not a location", shopPlaceFrom({ name: "sharma" }) === null);
  check("a place with no pincode leaves it empty", shopPlaceFrom({ geometry: { location: at(1, 2) } })?.pincode === null);
  const wizard = src("src/app/admin/vendors/new/registration-wizard.tsx");
  const editForm = src("src/app/admin/vendors/[id]/edit/vendor-form.tsx");
  check("both shop forms offer the Google search", wizard.includes("<GoogleShopSearch") && editForm.includes("<GoogleShopSearch"));
  check("going back in the wizard keeps Google's address", wizard.includes("reportInitial={false}"));
  const placesRoute = src("src/app/api/manager/vendors/places/route.ts");
  check("the manager's Google search needs the onboard permission and is rate-limited", placesRoute.includes('managerApiContext("manager.vendors.onboard")') && placesRoute.includes("managerWriteLimit("));
  check("the Google key stays on the server", src("src/lib/maps/places.server.ts").includes('import "server-only"') && !src("apps/manager/lib/features/vendors/onboard/google_shop_sheet.dart").includes("googleapis"));
}

{
  check("every rail entry has its own icon", new Set(ADMIN_NAV.map((i) => i.icon)).size === ADMIN_NAV.length);
  check("every rail entry is in a listed category", ADMIN_NAV.every((i) => (ADMIN_NAV_GROUPS as readonly string[]).includes(i.group)));
  const sidebar = src("src/components/admin/admin-sidebar.tsx");
  check("the rail is neutral: no raw palette colours, no per-entry colour", !/(text|bg)-(red|blue|green|amber|violet|pink|teal)-\d/.test(sidebar) && !sidebar.includes("dark:") && !sidebar.includes("--nav-hue") && !sidebar.includes("nav-tile"));
  check("rail labels are not tracked capitals", !sidebar.includes("uppercase") && !sidebar.includes("tracking-[0.1em]"));
  check("a keydown with no key cannot crash the top bar", src("src/components/admin/admin-top-bar.tsx").includes("e.key?.toLowerCase()"));
}

console.log("\n18. redirect-only pages");
check("both pages are gone", !existsSync(join(__dirname, "..", "..", "src/app/admin/food-images/page.tsx")) && !existsSync(join(__dirname, "..", "..", "src/app/admin/settings/categories/page.tsx")));
check("what Storage imports is still there", storage.includes("../food-images/food-image-library") && storage.includes("../settings/categories/categories-form"));
check("nothing points at the old addresses", !src("src/components/admin/admin-nav.ts").includes("/admin/food-images") && !src("src/app/api/admin/food-images/route.ts").includes('revalidatePath("/admin/food-images")'));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
