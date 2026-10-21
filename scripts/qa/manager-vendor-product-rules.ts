/**
 * QA — vendor and product rules (pure): status transitions, allowed actions,
 * required documents, cancellation / rejection rates, rating distribution,
 * availability history at the range edges, restricted categories, price change
 * percentages and seller ranking.
 *
 * Usage: npx tsx scripts/qa/manager-vendor-product-rules.ts
 */
import {
  allowedVendorActions,
  missingRequiredDocuments,
  nextVendorStatus,
  ratingDistribution,
  vendorRates,
} from "../../src/lib/ops/vendor-rules";
import {
  allowedProductActions,
  availabilityStats,
  frequentlyUnavailable,
  isRestrictedCategory,
  priceChangePct,
  rankSellers,
  type AvailabilityChange,
} from "../../src/lib/ops/product-rules";

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-6;

console.log("\n── vendor transitions ──");
check("approve pending → active", nextVendorStatus("pending", "approve") === "active");
check("approve rejected → active", nextVendorStatus("rejected", "approve") === "active");
check("approve active → null", nextVendorStatus("active", "approve") === null);
check("reject pending → rejected", nextVendorStatus("pending", "reject") === "rejected");
check("reject active → null", nextVendorStatus("active", "reject") === null);
check("suspend active → suspended", nextVendorStatus("active", "suspend") === "suspended");
check("suspend inactive → suspended", nextVendorStatus("inactive", "suspend") === "suspended");
check("suspend pending → null", nextVendorStatus("pending", "suspend") === null);
check("reactivate suspended → active", nextVendorStatus("suspended", "reactivate") === "active");
check("reactivate inactive → active", nextVendorStatus("inactive", "reactivate") === "active");
check("reactivate pending → null", nextVendorStatus("pending", "reactivate") === null);

console.log("\n── allowed vendor actions ──");
const all = { "manager.vendors.status": true, "manager.vendors.onboard": true };
check("nothing without manager.vendors.status",
  eq(allowedVendorActions({ status: "pending" }, {}),
    { approve: false, reject: false, suspend: false, reactivate: false, reviewDocuments: false, uploadDocuments: false }));
check("pending: approve, reject, review documents",
  eq(allowedVendorActions({ status: "pending" }, all),
    { approve: true, reject: true, suspend: false, reactivate: false, reviewDocuments: true, uploadDocuments: true }));
check("active: suspend only", eq(allowedVendorActions({ status: "active" }, { "manager.vendors.status": true }),
  { approve: false, reject: false, suspend: true, reactivate: false, reviewDocuments: true, uploadDocuments: false }));
check("suspended: reactivate", allowedVendorActions({ status: "suspended" }, all).reactivate === true);
check("uploads need manager.vendors.onboard",
  allowedVendorActions({ status: "active" }, { "manager.vendors.onboard": true }).uploadDocuments === true);

console.log("\n── required documents ──");
check("fssai verified, bank_proof rejected → bank_proof missing",
  eq(missingRequiredDocuments([{ type: "fssai", status: "verified" }, { type: "bank_proof", status: "rejected" }]), ["bank_proof"]));
check("none uploaded → both, in order", eq(missingRequiredDocuments([]), ["fssai", "bank_proof"]));
check("a verified copy among rejected ones counts",
  eq(missingRequiredDocuments([
    { type: "fssai", status: "rejected" }, { type: "fssai", status: "verified" }, { type: "bank_proof", status: "verified" },
  ]), []));

console.log("\n── vendor rates ──");
const T0 = "2026-10-01T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const orders = [
  ...Array.from({ length: 8 }, () => ({ status: "delivered", cancelledBy: null, createdAt: T0, acceptedAt: at(4), readyAt: at(24) })),
  { status: "cancelled", cancelledBy: "vendor", createdAt: T0, acceptedAt: null, readyAt: null },
  { status: "cancelled", cancelledBy: "customer", createdAt: T0, acceptedAt: at(2), readyAt: null },
];
const rates = vendorRates(orders);
check("10 orders", rates.orders === 10);
check("cancellation rate 0.2", near(rates.cancellationRate, 0.2));
check("rejection rate 0.1 (vendor cancellations only)", near(rates.rejectionRate, 0.1));
check("accept mean over accepted orders only", near(rates.avgAcceptMinutes, (8 * 4 + 2) / 9), String(rates.avgAcceptMinutes));
check("prep mean over orders with both stamps", near(rates.avgPrepMinutes, 20));
const none = vendorRates([]);
check("no orders → zero rates and null means",
  none.orders === 0 && none.cancellationRate === 0 && none.rejectionRate === 0 && none.avgAcceptMinutes === null && none.avgPrepMinutes === null);
check("rating distribution", eq(ratingDistribution([5, 5, 4, 1, 3, 5, 7, 0]), { "1": 1, "2": 0, "3": 1, "4": 1, "5": 3 }));

console.log("\n── availability history ──");
const range = { start: new Date("2026-10-10T00:00:00Z"), endExclusive: new Date("2026-10-11T00:00:00Z") };
const ch = (itemId: string, iso: string, to: boolean): AvailabilityChange => ({ itemId, at: iso, to });
let a = availabilityStats("x", [ch("x", "2026-10-05T00:00:00Z", false)], false, range);
check("unavailable since before the range, no change inside → whole range, 0 times", near(a.hoursUnavailable, 24) && a.timesUnavailable === 0, JSON.stringify(a));
a = availabilityStats("x", [ch("x", "2026-10-10T14:00:00Z", true), ch("x", "2026-10-10T10:00:00Z", false)], true, range);
check("off 10:00 → on 14:00 (given out of order) → 1 time, 4 h", a.timesUnavailable === 1 && near(a.hoursUnavailable, 4), JSON.stringify(a));
a = availabilityStats("x", [], false, range);
check("never changed and unavailable now → whole range", near(a.hoursUnavailable, 24) && a.timesUnavailable === 0);
a = availabilityStats("x", [], true, range);
check("never changed and available → 0 h", a.hoursUnavailable === 0 && a.timesUnavailable === 0);
a = availabilityStats("x", [ch("x", "2026-10-10T20:00:00Z", false), ch("x", "2026-10-11T00:00:00Z", true)], true, range);
check("a change exactly at the range end is ignored; open interval runs to the end", a.timesUnavailable === 1 && near(a.hoursUnavailable, 4), JSON.stringify(a));
a = availabilityStats("x", [ch("x", "2026-10-12T00:00:00Z", true)], true, range);
check("a change after the range decides the state inside it (was off)", near(a.hoursUnavailable, 24), JSON.stringify(a));
const toggles = Array.from({ length: 20 }, (_, i) => ch("y", new Date(Date.parse("2026-10-10T01:00:00Z") + i * 30 * 60_000).toISOString(), i % 2 === 1));
a = availabilityStats("y", toggles, true, range);
check("ten toggles off/on half-hourly → 10 times, 5 h", a.timesUnavailable === 10 && near(a.hoursUnavailable, 5), JSON.stringify(a));
a = availabilityStats("x", [ch("z", "2026-10-10T10:00:00Z", false)], true, range);
check("another item's changes are ignored", a.timesUnavailable === 0 && a.hoursUnavailable === 0);

const items = [
  { id: "p", available: true }, { id: "q", available: false }, { id: "r", available: true },
];
const changes = [
  ...Array.from({ length: 6 }, (_, i) => ch("p", new Date(Date.parse("2026-10-10T02:00:00Z") + i * 60 * 60_000).toISOString(), i % 2 === 1)),
  ch("q", "2026-10-01T00:00:00Z", false),
  ch("r", "2026-10-10T10:00:00Z", false), ch("r", "2026-10-10T11:00:00Z", true),
];
const freq = frequentlyUnavailable(items, changes, range);
check("frequently unavailable: 3+ times or 24+ h, sorted by hours", eq(freq.map((f) => f.item.id), ["q", "p"]), JSON.stringify(freq));

console.log("\n── products ──");
check("restricted match trims and ignores case", isRestrictedCategory(" Liquor ", ["liquor"]));
check("null category is never restricted", !isRestrictedCategory(null, ["liquor"]));
check("other categories are not", !isRestrictedCategory("Starters", ["liquor"]));
check("price change 160 → 180 is 12.5%", priceChangePct(160, 180) === 12.5);
check("from 0 → null", priceChangePct(0, 10) === null);
check("a drop is negative", priceChangePct(200, 150) === -25);
const view = { "manager.products.view": true };
const mod = { ...view, "manager.products.moderate": true };
check("flag needs only products.view", allowedProductActions({ approvalStatus: "approved", hidden: false, openFlags: 0 }, view).flag === true);
check("hide needs products.moderate",
  allowedProductActions({ approvalStatus: "approved", hidden: false, openFlags: 0 }, view).hide === false
  && allowedProductActions({ approvalStatus: "approved", hidden: false, openFlags: 0 }, mod).hide === true);
check("unhide only when hidden",
  allowedProductActions({ approvalStatus: "approved", hidden: true, openFlags: 0 }, mod).unhide === true
  && allowedProductActions({ approvalStatus: "approved", hidden: true, openFlags: 0 }, mod).hide === false);
check("approve / reject only when pending",
  allowedProductActions({ approvalStatus: "pending", hidden: false, openFlags: 0 }, mod).approve === true
  && allowedProductActions({ approvalStatus: "approved", hidden: false, openFlags: 0 }, mod).approve === false);
check("adjustStock only with products.adjust_stock",
  allowedProductActions({ approvalStatus: "approved", hidden: false, openFlags: 0 }, mod).adjustStock === false
  && allowedProductActions({ approvalStatus: "approved", hidden: false, openFlags: 0 }, { ...mod, "manager.products.adjust_stock": true }).adjustStock === true);
check("nothing without products.view",
  eq(allowedProductActions({ approvalStatus: "pending", hidden: true, openFlags: 2 }, {}),
    { flag: false, hide: false, unhide: false, approve: false, reject: false, adjustStock: false }));

const sellers = [
  { id: "a", units: 5, revenue: 500 }, { id: "b", units: 0, revenue: 0 }, { id: "c", units: 12, revenue: 900 },
  { id: "d", units: 5, revenue: 700 },
];
check("top sellers by units, then revenue", eq(rankSellers(sellers, "top", 3).map((s) => s.id), ["c", "d", "a"]));
check("slow sellers put zero units first", eq(rankSellers(sellers, "slow", 2).map((s) => s.id), ["b", "a"]));
check("ranking does not mutate its input", sellers[0].id === "a");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
