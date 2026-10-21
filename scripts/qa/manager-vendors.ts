/**
 * QA — manager vendors (§4): query parsing, the name cursor, the pinned
 * serialisers (finance omitted without manager.finance.view, never a bank /
 * PAN / GST / UPI key, first names only in reviews), the open-state mapping,
 * and structural rules on the routes and the data layer. The live section runs
 * against a dev server when BASE is reachable and QA_MANAGER_COOKIE is set.
 *
 * Usage: npx tsx scripts/qa/manager-vendors.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildVendorDetail,
  decodeNameCursor,
  encodeNameCursor,
  firstName,
  openStateOf,
  parseVendorQuery,
  toReviewItem,
  toTicketSummary,
  toVendorDocument,
  toVendorListItem,
  type VendorDetailInput,
} from "../../src/lib/ops/vendor-contract";

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
const qp = (s: string) => new URLSearchParams(s);
const ZONE = randomUUID();

console.log("\n── query parsing ──");
let p = parseVendorQuery(qp(""));
check("defaults: limit 50, no filters", p.ok && p.query.limit === 50 && p.query.statuses.length === 0 && p.query.filter === null);
p = parseVendorQuery(qp("filter=online&limit=20"));
check("filter=online", p.ok && p.query.filter === "online" && p.query.limit === 20);
p = parseVendorQuery(qp("status=active,suspended"));
check("status list", p.ok && p.query.statuses.join() === "active,suspended");
p = parseVendorQuery(qp("status=active,eaten"));
check("an unknown status → field status", !p.ok && p.field === "status");
p = parseVendorQuery(qp("limit=101"));
check("limit 101 → field limit", !p.ok && p.field === "limit");
p = parseVendorQuery(qp("q=a"));
check("a one-letter search → field q", !p.ok && p.field === "q");
p = parseVendorQuery(qp("filter=sleepy"));
check("an unknown filter → field filter", !p.ok && p.field === "filter");
p = parseVendorQuery(qp(`zone=${ZONE}&category=Restaurant&q=spice`));
check("zone, category and q pass through", p.ok && p.query.zone === ZONE && p.query.category === "Restaurant" && p.query.q === "spice");
p = parseVendorQuery(qp("zone=not-a-uuid"));
check("a non-uuid zone → field zone", !p.ok && p.field === "zone");
p = parseVendorQuery(qp("cursor=%%%"));
check("a garbage cursor → field cursor", !p.ok && p.field === "cursor");

console.log("\n── name cursor ──");
const id = randomUUID();
const c = encodeNameCursor("Spice, Hub (Main) \"1\"", id);
const d = decodeNameCursor(c);
check("round trip keeps commas, brackets and quotes", d !== null && d.name === "Spice, Hub (Main) \"1\"" && d.id === id);
check("a cursor with a bad id is refused", decodeNameCursor(Buffer.from("x|nope").toString("base64url")) === null);

console.log("\n── open state ──");
for (const s of ["open", "closed", "temporarily_closed", "holiday", "weekly_off", "outside_hours"]) {
  check(`${s} maps to itself`, openStateOf(s) === s);
}
check("an unknown or missing answer is closed", openStateOf(null) === "closed" && openStateOf("weird") === "closed");

console.log("\n── serialisers ──");
const listRow = {
  id, name: "Spice Hub", slug: "spice-hub", status: "active", category: "Restaurant", zone_id: ZONE,
  zone_name: "Bemetara", image_url: null, rating: "4.26", rating_count: 120, created_at: "2026-09-01T10:00:00Z",
};
const item = toVendorListItem(listRow, { openState: "open", todayOrders: 14, pendingDocuments: 1, openComplaints: 0 });
check("list item shape", item.id === id && item.zone.name === "Bemetara" && item.rating === 4.3 && item.ratingCount === 120
  && item.openState === "open" && item.todayOrders === 14 && item.logoUrl === null);
check("no rating → 0", toVendorListItem({ ...listRow, rating: null, rating_count: null }, { openState: "closed", todayOrders: 0, pendingDocuments: 0, openComplaints: 0 }).rating === 0);
check("first name of a full name", firstName("Asha Verma") === "Asha" && firstName("  ") === null && firstName(null) === null);
const review = toReviewItem({
  id, rating: 4, comment: "Nice", created_at: "2026-10-01T10:00:00Z", status: "hidden_by_admin", order_id: id,
  food_quality: 4, packaging: null, delivery_experience: 5, value_for_money: null,
  profiles: { full_name: "Asha Verma", phone: "+919800000000" },
  review_replies: [{ reply_text: "Thanks", created_at: "2026-10-02T10:00:00Z", removed_at: null }],
});
check("review: first name only, no phone anywhere", review.customerFirstName === "Asha" && !JSON.stringify(review).includes("9800000000"));
check("review status hidden_by_admin → hidden", review.status === "hidden");
check("review order code is the short code", review.orderCode === id.slice(0, 8).toUpperCase());
check("review reply carried", review.reply?.text === "Thanks");
check("a removed reply is not shown", toReviewItem({ ...{ id, rating: 4, comment: null, created_at: "x", status: "published", order_id: null,
  food_quality: null, packaging: null, delivery_experience: null, value_for_money: null, profiles: null,
  review_replies: [{ reply_text: "x", created_at: "x", removed_at: "y" }] } }).reply === null);
const doc = toVendorDocument({ id, doc_type: "fssai", file_name: "f.pdf", status: "verified", remarks: null,
  reviewed_by: id, reviewed_at: "2026-10-01T10:00:00Z", created_at: "2026-09-01T10:00:00Z" }, new Map([[id, "Mona"]]));
check("document with reviewer name", doc.type === "fssai" && doc.reviewedBy?.name === "Mona" && doc.uploadedAt === "2026-09-01T10:00:00Z");
const ticket = toTicketSummary({ id, number: 17, subject: "Late", category: "order_issue", priority: "high", status: "escalated",
  requester_role: "customer", order_id: null, created_at: "a", updated_at: "b" });
check("ticket summary", ticket.number === 17 && ticket.requesterRole === "customer" && ticket.status === "escalated");

const input: VendorDetailInput = {
  row: {
    ...listRow, status_reason: "ok", status_changed_at: null, description: null, shop_phone: "0771", owner_name: "Vik",
    owner_mobile: "+919811111111", owner_email: "v@x.in", address: "Main road", landmark: null, pincode: "491335", lat: 21.7, lng: null,
    opening_time: "09:00:00", closing_time: "23:00:00", weekly_off: ["Monday"], closed_until: null, delivery_available: true,
    self_pickup: false, prep_minutes: 20, fssai_number: "123", tc_accepted_at: null, tc_version: null,
    bank_account_number: "999", pan_number: "ABCDE", gst_number: "22AAA", upi_id: "v@upi",
  } as VendorDetailInput["row"],
  extras: { openState: "open", todayOrders: 3, pendingDocuments: 0, openComplaints: 1 },
  statusChangedBy: null,
  documents: [doc],
  holidays: [{ starts_on: "2026-11-01", ends_on: "2026-11-02", note: null }],
  performance: { from: "2026-09-21", to: "2026-10-20", orders: 4, sales: 900, aov: 225, cancellationRate: 0.25, rejectionRate: 0,
    avgAcceptMinutes: 3, avgPrepMinutes: null, rating: 4.3, ratingCount: 120, ratingDistribution: { "1": 0, "2": 0, "3": 1, "4": 1, "5": 2 } },
  finance: { commissionPct: 12, commissionGstPct: 18, otherChargesPerOrder: 0, settlementCycle: "weekly", pendingPayment: 100,
    recoverable: 0, commissionThisPeriod: 50, settlements: [] },
  openComplaints: [ticket],
  allowed: { approve: false, reject: false, suspend: true, reactivate: false, reviewDocuments: true, uploadDocuments: false },
};
const withFinance = buildVendorDetail(input, { "manager.finance.view": true });
const without = buildVendorDetail(input, {});
check("finance present with manager.finance.view", "finance" in withFinance && withFinance.finance?.pendingPayment === 100);
check("finance key absent without it", !("finance" in without));
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
  return out;
}
const banned = keys(withFinance).filter((k) => /bank|pan_?number|gst_?number|upi/i.test(k));
check("no bank, PAN, GST or UPI key anywhere", banned.length === 0, banned.join());
check("no bank value leaked", !JSON.stringify(withFinance).includes("ABCDE") && !JSON.stringify(withFinance).includes("v@upi"));
check("hours as HH:MM and weekly off lower-case", withFinance.hours.opening === "09:00" && withFinance.hours.weeklyOff[0] === "monday");
check("unpinned → lat and lng null", withFinance.address.lat === null && withFinance.address.lng === null);
check("holidays mapped", withFinance.hours.holidays[0].from === "2026-11-01");
check("contact carried", withFinance.contact.ownerMobile === "+919811111111" && withFinance.contact.shopPhone === "0771");

console.log("\n── structural ──");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const routes = walk("src/app/api/manager/vendors").filter((f) => f.endsWith("route.ts"));
check("vendor routes exist", routes.length >= 5, routes.join());
for (const r of routes) {
  const src = readFileSync(r, "utf8");
  check(`${r} opens with managerApiContext`, /managerApiContext\(/.test(src));
}
const da = readFileSync("src/lib/data-access/manager-vendors.ts", "utf8");
check("no select(\"*\") in manager-vendors.ts", !/select\(\s*["']\*["']/.test(da));
check("no bank / PAN / GST / UPI column selected", !/bank_account|pan_number|gst_number|upi_id|vendor_login_credentials/.test(da));
const restaurantReads = da.split('from("restaurants")').length - 1;
const scoped = (da.match(/applyZoneScope|scopeZoneIds|scopeAllows/g) ?? []).length;
check("every restaurants read is followed by a scope check", restaurantReads > 0 && scoped >= restaurantReads, `${restaurantReads} reads, ${scoped} scope uses`);

console.log("\n── live (optional) ──");
const BASE = process.env.BASE ?? "http://localhost:3005";
const cookie = process.env.QA_MANAGER_COOKIE;
async function live() {
  try {
    const r = await fetch(`${BASE}/api/manager/vendors`, { redirect: "manual" });
    check("unauthenticated → 401", r.status === 401);
  } catch {
    console.log("  skip (dev server unreachable)");
    return;
  }
  if (!cookie) {
    console.log("  skip signed-in checks (QA_MANAGER_COOKIE unset)");
    return;
  }
  const r = await fetch(`${BASE}/api/manager/vendors/${randomUUID()}`, { headers: { cookie } });
  check("an unknown or out-of-zone id → 404", r.status === 404);
}
void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
