/**
 * QA — Phase 7 offers: the contract (query and body parsing, serialisers,
 * what a manager may do), the basket the checkout preview prices, and the
 * routes' structure. Pure and structural.
 *
 * Usage:  npm run test:manager-offers
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  offerAllowed, parseCreateOfferBody, parseOfferActionBody, parseOfferQuery, parseUpdateOfferBody, serializeChange,
  serializeOfferDetail, type OfferRow,
} from "../../src/lib/ops/offer-contract";
import { offerUsage } from "../../src/lib/ops/offer-rules";
import { parseBasket, resolveBasket } from "../../src/lib/coupons/basket";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}
const now = new Date("2026-11-03T12:00:00+05:30");
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const field = (r: { ok: boolean; field?: string }) => (r.ok ? null : r.field);

console.log("\n── bodies ──");
const create = { code: "diwali50", kind: "flat", value: 50, expiresAt: "2026-12-01T00:00:00Z", zoneIds: [U(1)], clientActionId: "abcdefgh" };
check("a manager's create, code upper-cased", (() => { const r = parseCreateOfferBody(create, now, false); return r.ok && r.terms.code === "DIWALI50"; })());
check("a manager's create without an end → expiresAt", field(parseCreateOfferBody({ ...create, expiresAt: null }, now, false)) === "expiresAt");
check("an admin's create may leave the end open", parseCreateOfferBody({ ...create, expiresAt: null }, now, true).ok);
check("percent above 90 → value", field(parseCreateOfferBody({ ...create, kind: "percent", value: 91 }, now, false)) === "value");
check("no clientActionId → clientActionId", field(parseCreateOfferBody({ ...create, clientActionId: undefined }, now, false)) === "clientActionId");
const upd = { expectedUpdatedAt: "2026-11-01T00:00:00Z", changes: { maxDiscount: 80 }, reason: "Budget cut", clientActionId: "abcdefgh" };
check("an edit with a token and a reason", parseUpdateOfferBody(upd, now).ok);
check("an edit changing the code → code", field(parseUpdateOfferBody({ ...upd, changes: { code: "NEW" } }, now)) === "code");
check("an edit without a reason → reason_required", (() => { const r = parseUpdateOfferBody({ ...upd, reason: "" }, now); return !r.ok && r.error === "reason_required"; })());
check("an empty edit → changes", field(parseUpdateOfferBody({ ...upd, changes: {} }, now)) === "changes");
check("an action without a reason → reason_required", (() => { const r = parseOfferActionBody({ action: "activate", reason: "x", clientActionId: "abcdefgh" }); return !r.ok && r.error === "reason_required"; })());
check("query: bad state → state", field(parseOfferQuery(new URLSearchParams("state=live"))) === "state");
check("query: defaults to all, 50", (() => { const r = parseOfferQuery(new URLSearchParams("")); return r.ok && r.q.state === "all" && r.q.limit === 50; })());

console.log("\n── serialisers and permissions ──");
const row = (x: Partial<OfferRow> = {}): OfferRow => ({ code: "SPICE10", label: null, kind: "percent", value: "10.00", min_order: "0.00",
  max_discount: null, active: true, starts_at: null, expires_at: "2026-12-01T00:00:00Z", max_per_customer: 1, max_redemptions: 500,
  funded_by: "vendor", created_by: U(5), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", vendor_ids: [U(2)],
  zone_ids: [], item_ids: [], platform_wide: false, in_scope: true, redemptions: 12, discount_given: 600, ...x });
const names = { shop: () => "Spice Hub", zone: () => "Bemetara", person: () => "Vik", item: () => "Roll" };
const d = serializeOfferDetail(row(), names, now, false, null, []);
const KEYS = ["code", "label", "kind", "value", "minOrder", "maxDiscount", "state", "active", "startsAt", "expiresAt", "fundedBy", "vendors", "zones",
  "itemCount", "redemptions", "maxRedemptions", "discountGiven", "createdBy", "updatedAt", "maxPerCustomer", "items", "requestId", "campaignIds", "allowed"];
check("detail: exactly the pinned keys", JSON.stringify(Object.keys(d).sort()) === JSON.stringify([...KEYS].sort()), Object.keys(d));
check("detail: numbers, not numeric strings", d.value === 10 && d.minOrder === 0);
check("a platform-wide code is read-only to a manager", JSON.stringify(offerAllowed(row({ platform_wide: true, vendor_ids: [] }), now, false))
  === JSON.stringify({ edit: false, activate: false, deactivate: false }));
check("...but not to an admin", offerAllowed(row({ platform_wide: true, vendor_ids: [] }), now, true).deactivate === true);
check("a code reaching beyond the manager's zones is read-only", offerAllowed(row({ in_scope: false }), now, false).edit === false);
check("an expired, switched-off code cannot be activated", offerAllowed(row({ active: false, expires_at: "2026-11-01T00:00:00Z" }), now, false).activate === false);
check("a used-up code cannot be activated", offerAllowed(row({ active: false, redemptions: 500 }), now, false).activate === false);
const ch = serializeChange({ id: 7, created_at: "2026-11-01T10:00:00Z", actor_id: U(5), op: "update", target: "coupon",
  before: { code: "X", max_discount: 80, value: 10 }, after: { code: "X", max_discount: 100, value: 10 }, reason: "More" },
  () => ({ name: "Mona", role: "manager" }));
check("a change lists only what changed, camelCased", ch.fields.length === 1 && ch.fields[0].field === "maxDiscount"
  && ch.fields[0].before === "80" && ch.fields[0].after === "100" && ch.actor?.role === "manager");

console.log("\n── usage ──");
const u = offerUsage([
  { orderId: "a", customerId: "c1", discount: 50, createdAt: "2026-11-01T10:00:00+05:30", restaurantId: "s1", cancelled: false, orderTotal: 300, fundedBy: "vendor", firstOrder: true },
  { orderId: "b", customerId: "c2", discount: 40, createdAt: "2026-11-02T10:00:00+05:30", restaurantId: "s2", cancelled: false, orderTotal: 260, fundedBy: "platform", firstOrder: false },
], { from: "2026-11-01", to: "2026-11-03" }, { maxRedemptions: null, totalRedemptions: 2 });
check("usage totals equal the sum of daily", u.daily.reduce((s, x) => s + x.discountGiven, 0) === u.discountGiven && u.discountGiven === 90);
check("...split by funder; unlimited leaves remaining null", u.discountByFunder.vendor === 50 && u.discountByFunder.platform === 40 && u.remainingRedemptions === null);

console.log("\n── basket ──");
check("101 lines are refused", parseBasket(Array.from({ length: 101 }, () => ({ menuItemId: "a", qty: 1 }))) === null);
check("qty 0 or 51 is refused", parseBasket([{ menuItemId: "a", qty: 0 }]) === null && parseBasket([{ menuItemId: "a", qty: 51 }]) === null);
const resolved = resolveBasket([{ menuItemId: "ext-roll", qty: 2 }, { menuItemId: U(9).toUpperCase(), qty: 1 }, { menuItemId: "gone", qty: 1 }],
  [{ id: U(8), external_id: "ext-roll" }, { id: U(9), external_id: null }]);
check("external ids and uuids resolve to the shop's uuids; unknown dishes drop", JSON.stringify(resolved)
  === JSON.stringify([{ menuItemId: U(8), qty: 2 }, { menuItemId: U(9), qty: 1 }]), resolved);

console.log("\n── routes (structure) ──");
const api = join(__dirname, "../../src/app/api/manager/offers");
for (const f of ["route.ts", "[code]/route.ts", "[code]/actions/route.ts"]) {
  const src = readFileSync(join(api, f), "utf8");
  const handlers = [...src.matchAll(/export async function (GET|POST|PATCH)/g)].map((x) => x[1]);
  check(`${f}: every handler opens with managerApiContext("manager.offers.manage")`,
    (src.match(/managerApiContext\("manager\.offers\.manage"\)/g) ?? []).length === handlers.length);
  for (const h of handlers.filter((x) => x !== "GET")) {
    const start = src.indexOf(`export async function ${h}`);
    const next = src.indexOf("export async function", start + 1);
    check(`${f} ${h}: rate-limited`, src.slice(start, next === -1 ? undefined : next).includes("managerWriteLimit("));
  }
}
const adminActions = readFileSync(join(__dirname, "../../src/app/admin/coupons/actions.ts"), "utf8");
check("admin coupon saves go through the audited path", adminActions.includes("adminSaveOffer(") && adminActions.includes("adminSetOfferActive(")
  && !/createPromotion\(|updatePromotion\(|setPromotionActive\(/.test(adminActions));
const adminOffers = readFileSync(join(__dirname, "../../src/lib/data-access/admin-offers.ts"), "utf8");
check("admin-offers writes only through RPCs", !/from\("coupons"\)\s*\.(insert|update|upsert|delete)/.test(adminOffers));
const validate = readFileSync(join(__dirname, "../../src/app/api/coupons/validate/route.ts"), "utf8");
check("validate route parses the basket", validate.includes("parseBasket(") && !/export function/.test(validate));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
