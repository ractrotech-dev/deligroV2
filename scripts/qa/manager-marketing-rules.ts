/**
 * QA — Phase 7 pure rules: campaign state and validation, the featured-slot
 * overlay, attribution, offer state/validation/usage, phone masking, and
 * retention. No database.
 *
 * Usage:  npm run test:manager-marketing-rules
 */
import {
  campaignEditable,
  campaignState,
  effectiveVendorPositions,
  effectiveVendorPositionsByZone,
  liveWindow,
  placedFeatured,
  validateCampaignInput,
  SLOT_COUNT,
} from "../../src/lib/marketing/campaign-rules";
import { attributeOrders, campaignPerformance, type AttrOrder } from "../../src/lib/marketing/attribution";
import { maskPhone, offerState, offerUsage, validateOfferTerms } from "../../src/lib/ops/offer-rules";
import { retentionCohorts, retentionSummary, type CustomerFact } from "../../src/lib/metrics/customers";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

const now = new Date("2026-11-03T12:00:00+05:30");
const at = (iso: string) => new Date(iso);

console.log("\n── campaign state ──");
const camp = { status: "approved", startsAt: "2026-11-03T12:00:00+05:30", endsAt: "2026-11-10T12:00:00+05:30" };
check("1 ms before start → scheduled", campaignState(camp, new Date(Date.parse(camp.startsAt) - 1)) === "scheduled");
check("at start → active", campaignState(camp, at(camp.startsAt)) === "active");
check("at end → expired", campaignState(camp, at(camp.endsAt)) === "expired");
check("cancelled inside the window → expired", campaignState({ ...camp, status: "cancelled" }, now) === "expired");
check("editable while active: window only, end now, no cancel",
  JSON.stringify(campaignEditable({ ...camp, kind: "banner" }, now)) === JSON.stringify({ edit: true, editWindowOnly: true, cancel: false, endNow: true, uploadImage: true }));

console.log("\n── featured overlay ──");
const pos = effectiveVendorPositions(new Map([["A", 1], ["B", 2]]), [{ restaurantId: "C", slot: 1 }]);
check("manual {A:1,B:2} + featured C@1 → {C:1,A:2,B:3}", pos.get("C") === 1 && pos.get("A") === 2 && pos.get("B") === 3, [...pos]);
const full = new Map(Array.from({ length: SLOT_COUNT }, (_, i) => [`S${i + 1}`, i + 1] as [string, number]));
const pushed = effectiveVendorPositions(full, [{ restaurantId: "X", slot: 3 }]);
check("an 11th shop drops off", pushed.size === SLOT_COUNT && !pushed.has("S10") && pushed.get("X") === 3 && pushed.get("S3") === 4);
check("a shop pinned at 5 keeps 5 when nothing displaces it", effectiveVendorPositions(new Map([["A", 5]]), []).get("A") === 5);
check("pinned and featured appears once, at its campaign slot",
  effectiveVendorPositions(new Map([["A", 1]]), [{ restaurantId: "A", slot: 4 }]).get("A") === 4);

console.log("\n── campaign input ──");
const Z = "11111111-1111-1111-1111-111111111111", V = "22222222-2222-2222-2222-222222222222", I = "33333333-3333-3333-3333-333333333333";
const base = { kind: "featured_store", title: "Diwali top", zoneId: Z, vendorIds: [V], startsAt: "2026-11-04T00:00:00+05:30",
  endsAt: "2026-11-11T00:00:00+05:30", fundedBy: "deligro", slotPosition: 2 };
check("a valid featured input", validateCampaignInput(base, now).ok);
const field = (x: unknown) => { const r = validateCampaignInput(x, now); return r.ok ? null : r.field; };
check("featured without a slot → slotPosition", field({ ...base, slotPosition: null }) === "slotPosition");
check("end before start → endsAt", field({ ...base, endsAt: "2026-11-03T00:00:00+05:30" }) === "endsAt");
check("181 days → endsAt", field({ ...base, endsAt: "2027-05-05T00:00:00+05:30" }) === "endsAt");
check("shared without a share → vendorSharePct", field({ ...base, fundedBy: "shared" }) === "vendorSharePct");
check("sponsored without dishes → itemIds", field({ ...base, kind: "sponsored_product", slotPosition: null }) === "itemIds");
check("a banner without banner fields → banner", field({ ...base, kind: "banner", slotPosition: null }) === "banner");
check("an external banner target must be https", field({ ...base, kind: "banner", slotPosition: null,
  banner: { headline: "Hi", ctaLabel: "Go", targetType: "external", targetValue: "http://x" } }) === "banner");
check("a start an hour ago → startsAt", field({ ...base, startsAt: "2026-11-03T11:00:00+05:30" }) === "startsAt");

console.log("\n── attribution ──");
const c = { id: "c1", kind: "featured_store" as const, startsAt: "2026-11-01T00:00:00+05:30", endsAt: "2026-11-08T00:00:00+05:30",
  offerCode: "DIWALI50", vendorIds: ["shop"], itemIds: [] };
const o = (id: string, createdAt: string, extra: Partial<AttrOrder> = {}): AttrOrder => ({ id, customerId: "cust", restaurantId: "shop",
  createdAt, status: "delivered", total: 400, couponCode: null, menuItemIds: ["dish"], counted: true, ...extra });
const click = (createdAt: string) => ({ customerId: "cust", createdAt });
const T = "2026-11-05T12:00:00+05:30";
const hoursBefore = (h: number) => new Date(Date.parse(T) - h * 3_600_000).toISOString();
check("a click 23 h before the order at the shop → counted", attributeOrders(c, [o("o1", T)], [click(hoursBefore(23))]).orders === 1);
check("25 h before → not", attributeOrders(c, [o("o1", T)], [click(hoursBefore(25))]).orders === 0);
check("a click after the order → not", attributeOrders(c, [o("o1", T)], [click(hoursBefore(-1))]).orders === 0);
check("a cancelled order → not", attributeOrders(c, [o("o1", T, { status: "cancelled" })], [click(hoursBefore(1))]).orders === 0);
check("an unpaid online checkout → not", attributeOrders(c, [o("o1", T, { counted: false })], [click(hoursBefore(1))]).orders === 0);
const twice = attributeOrders(c, [o("o1", T, { couponCode: "DIWALI50" }), o("o1", T, { couponCode: "DIWALI50" })], [click(hoursBefore(1))]);
check("code + click on the same order counts once", twice.orders === 1 && twice.sales === 400);
const sponsored = { ...c, kind: "sponsored_product" as const, offerCode: null, itemIds: ["promo-dish"] };
check("sponsored: an order without a campaign dish → not", attributeOrders(sponsored, [o("o1", T)], [click(hoursBefore(1))]).orders === 0);
check("sponsored: with the dish → counted", attributeOrders(sponsored, [o("o1", T, { menuItemIds: ["promo-dish"] })], [click(hoursBefore(1))]).orders === 1);
check("outside the window → not", attributeOrders(c, [o("o1", "2026-11-09T12:00:00+05:30", { couponCode: "DIWALI50" })], []).orders === 0);
const perf = campaignPerformance(c,
  [{ kind: "impression", createdAt: T }, { kind: "impression", createdAt: T }, { kind: "click", createdAt: T }],
  [click(hoursBefore(1))], [o("o1", T)], [{ orderId: "o1", discount: 50, createdAt: T }],
  { from: "2026-11-01", to: "2026-11-07" }, [o("o1", T), o("old", "2026-10-28T12:00:00+05:30")]);
check("performance: ctr 50%, one attributed ₹400, ₹50 discount", perf.ctr === 50 && perf.attributedSales === 400 && perf.discountGiven === 50);
check("...daily sums equal the totals", perf.daily.reduce((s, d) => s + d.attributedSales, 0) === perf.attributedSales
  && perf.daily.reduce((s, d) => s + d.impressions, 0) === perf.impressions);
check("...before/during comparison for a featured shop", perf.comparison?.beforeOrders === 1 && perf.comparison?.duringOrders === 1);

console.log("\n── offers ──");
const st = (x: Partial<Parameters<typeof offerState>[0]>) => offerState({ active: true, startsAt: null, expiresAt: null, maxRedemptions: null, redemptions: 0, ...x }, now);
check("inactive beats expired", st({ active: false, expiresAt: "2026-11-01T00:00:00Z" }) === "inactive");
check("expired beats exhausted", st({ expiresAt: "2026-11-01T00:00:00Z", maxRedemptions: 1, redemptions: 1 }) === "expired");
check("exhausted beats scheduled", st({ startsAt: "2026-12-01T00:00:00Z", maxRedemptions: 1, redemptions: 1 }) === "exhausted");
check("not started → scheduled", st({ startsAt: "2026-12-01T00:00:00Z" }) === "scheduled");
check("otherwise active", st({}) === "active");
const of = (x: unknown, opts = { requireExpiry: true }) => { const r = validateOfferTerms(x, now, opts); return r.ok ? null : r.field; };
const terms = { code: "diwali50", kind: "percent", value: 20, expiresAt: "2026-12-01T00:00:00Z", zoneIds: [Z] };
check("valid terms; the code is upper-cased", (() => { const r = validateOfferTerms(terms, now, { requireExpiry: true }); return r.ok && r.value.code === "DIWALI50"; })());
check("percent 95 → value", of({ ...terms, value: 95 }) === "value");
check("no expiresAt for a manager → expiresAt", of({ ...terms, expiresAt: null }) === "expiresAt");
check("400 days ahead → expiresAt", of({ ...terms, expiresAt: "2027-12-10T00:00:00Z" }) === "expiresAt");
check("dishes without a vendor → vendorIds", of({ ...terms, itemIds: [I] }) === "vendorIds");
check("an edit cannot change the code", (() => { const r = validateOfferTerms({ code: "X" }, now, { partial: true }); return !r.ok && r.field === "code"; })());
const red = (orderId: string, createdAt: string, extra = {}) => ({ orderId, customerId: orderId === "r3" ? "c2" : "c1", discount: 50, createdAt,
  restaurantId: "shop", cancelled: false, orderTotal: 350, fundedBy: "platform" as const, firstOrder: orderId === "r1", ...extra });
const usage = offerUsage([red("r1", "2026-11-01T10:00:00+05:30"), red("r2", "2026-11-02T10:00:00+05:30"),
  red("r3", "2026-11-02T11:00:00+05:30", { cancelled: true })], { from: "2026-11-01", to: "2026-11-03" }, { maxRedemptions: 500, totalRedemptions: 3 });
check("usage: 2 kept, 1 cancelled, ₹100 given, 497 left", usage.redemptions === 2 && usage.cancelledRedemptions === 1
  && usage.discountGiven === 100 && usage.remainingRedemptions === 497 && usage.newCustomers === 1);
check("...daily totals equal the sum", usage.daily.reduce((s, d) => s + d.discountGiven, 0) === usage.discountGiven);
check("maskPhone(+919876543210) → ••••••3210", maskPhone("+919876543210") === "••••••3210");
check("maskPhone(null) → null", maskPhone(null) === null);

console.log("\n── retention ──");
const f = (id: string, first: string, second: string | null, inRange: number, spent: number): CustomerFact =>
  ({ customerId: id, firstOrderAt: first, secondOrderAt: second, ordersInRange: inRange, spentInRange: spent, lastOrderAt: first });
const facts = [
  f("a", "2026-06-05T10:00:00+05:30", "2026-06-20T10:00:00+05:30", 0, 0),
  f("b", "2026-06-10T10:00:00+05:30", null, 0, 0),
  f("c", "2026-10-02T10:00:00+05:30", "2026-10-05T10:00:00+05:30", 2, 700),
  f("d", "2026-10-15T10:00:00+05:30", null, 1, 300),
  f("e", "2026-03-01T10:00:00+05:30", "2026-10-20T10:00:00+05:30", 1, 200),
];
const sum = retentionSummary(facts, { from: "2026-10-01", to: "2026-10-31" });
check("summary: 3 customers, 2 new, 1 returning", sum.customers === 3 && sum.newCustomers === 2 && sum.returningCustomers === 1, sum);
check("...repeat rate 33.3%, 1.3 orders each, AOV 300", sum.repeatRate === 33.3 && sum.ordersPerCustomer === 1.3 && sum.aovPerCustomer === 300, sum);
const cohorts = retentionCohorts(facts, "2026-10-31");
const june = cohorts.find((x) => x.cohort === "2026-06");
check("June cohort: 2 customers, r30 50.0", june?.customers === 2 && june?.r30 === 50, june);
check("October cohort is too young for r90 → null", cohorts.find((x) => x.cohort === "2026-10")?.r90 === null);
check("six cohorts, oldest first", cohorts.length === 6 && cohorts[0].cohort === "2026-05" && cohorts[5].cohort === "2026-10");
const empty = retentionSummary([], { from: "2026-10-01", to: "2026-10-31" });
check("empty input → zeros, never NaN", Object.values(empty).every((v) => v === 0));


console.log("\n── review fixes: featured slots are per zone, the label is honest, and a cache never outlives a window ──");
const featA = { campaignId: "ca", restaurantId: "shopA", slot: 2, zoneId: "zoneA" };
const featB = { campaignId: "cb", restaurantId: "shopB", slot: 2, zoneId: "zoneB" };
const zoneOf = (id: string) => ({ shopA: "zoneA", shopB: "zoneB", pinA: "zoneA", pinB: "zoneB" } as Record<string, string>)[id] ?? null;
const both = effectiveVendorPositionsByZone(new Map(), zoneOf, [featA, featB]);
check("two zones can each hold slot 2 (a slot belongs to a zone's feed)", both.get("shopA") === 2 && both.get("shopB") === 2);
const pinned = effectiveVendorPositionsByZone(new Map([["pinA", 2], ["pinB", 2]]), zoneOf, [featA]);
check("a zone-A campaign displaces only zone-A pins", pinned.get("shopA") === 2 && pinned.get("pinA") === 3 && pinned.get("pinB") === 2);
check("a shop of no known zone is placed among its own, not displaced by anyone's campaign",
  effectiveVendorPositionsByZone(new Map([["lone", 2]]), () => null, [featA]).get("lone") === 2);
check("two campaigns in one zone for one slot: one is placed, one is not",
  placedFeatured([featA, { ...featA, campaignId: "cx", restaurantId: "shopX" }], effectiveVendorPositionsByZone(new Map(), zoneOf, [featA, { ...featA, restaurantId: "shopX" }])).size === 1);
const placed = placedFeatured([featA, featB], both);
check("the 'Featured' label goes only to a shop that took its campaign's slot", placed.get("shopA") === "ca" && placed.get("shopB") === "cb");
const pushedOut = new Map([["shopA", 5]]);
check("...a campaign whose shop did not land on its slot gets no label", placedFeatured([featA], pushedOut).size === 0);
const live = (starts: string, ends: string) => ({ startsAt: starts, endsAt: ends });
const rowsCached = [live("2026-11-03T00:00:00Z", "2026-11-03T10:00:00Z"), live("2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z"), live("2026-11-03T11:00:00Z", "2026-11-05T00:00:00Z")];
const nowUtc = new Date("2026-11-03T10:30:00Z");
check("a cached row stops counting the moment its window ends (and before it starts)", liveWindow(rowsCached, nowUtc).length === 1
  && liveWindow(rowsCached, nowUtc)[0].endsAt === "2026-11-04T00:00:00Z");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
