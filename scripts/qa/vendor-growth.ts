/**
 * QA — the Partner app's offers, marketing requests, support tickets,
 * announcements and customer insights: request bodies and the insight maths.
 *
 * Runs offline. Usage: npx tsx scripts/qa/vendor-growth.ts
 */
import {
  canMoveMarketing,
  parseAnnouncement,
  parseMarketingDecision,
  parseMarketingRequest,
  parseOfferBody,
  parseTicket,
  parseTicketMessage,
  validAttachments,
} from "../../src/lib/vendor/growth-input";
import { customerInsights, shortName } from "../../src/lib/vendor/insights";
import { validatePromotion } from "../../src/lib/promotion-rules";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${e}, got ${a}`);
  }
}
const err = (r: unknown) => (r && typeof r === "object" && "error" in r ? (r as { error: string }).error : null);
const SHOP = "0d3c7d4e-8a8f-4b7e-9a51-2c3b4d5e6f70";
const ME = "11111111-2222-3333-4444-555555555555";

console.log("\n═══ Offers ═══");
const offer = parseOfferBody({ code: " diwali 20 ", kind: "percent", value: 20, minOrder: 199, maxDiscount: 80, startsAt: "2026-11-01T00:00:00+05:30", expiresAt: "2026-11-05T23:59:00+05:30" }, SHOP);
check("code is normalised", (offer as { code: string }).code, "DIWALI20");
check("the shop is the session's", (offer as { restaurantId: string }).restaurantId, SHOP);
check("the vendor always pays", parseOfferBody({ code: "X1X1", kind: "flat", value: 30, fundedBy: "platform" }, SHOP) && (parseOfferBody({ code: "X1X1", kind: "flat", value: 30, fundedBy: "platform" }, SHOP) as { fundedBy: string }).fundedBy, "vendor");
check("start stored as an instant", (offer as { startsAt: string }).startsAt, "2026-10-31T18:30:00.000Z");
check("a valid draft passes the shared rules", validatePromotion(offer as never), null);
check("start after end is refused by the rules", validatePromotion(parseOfferBody({ code: "LATE1", kind: "flat", value: 10, startsAt: "2026-11-05T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z" }, SHOP) as never), "The offer has to start before it ends.");
check("a flat code drops any cap", (parseOfferBody({ code: "FLAT50", kind: "flat", value: 50, maxDiscount: 10 }, SHOP) as { maxDiscount: number | null }).maxDiscount, null);
check("unknown kind refused", err(parseOfferBody({ code: "AAAA", kind: "bogo", value: 1 }, SHOP)), "invalid_kind");
check("a fraction refused", err(parseOfferBody({ code: "AAAA", kind: "flat", value: 9.5 }, SHOP)), "invalid_value");
check("a bad date refused", err(parseOfferBody({ code: "AAAA", kind: "flat", value: 9, startsAt: "soon" }, SHOP)), "invalid_startsAt");

console.log("\n═══ Marketing requests ═══");
const today = "2026-10-21";
const mr = { kind: "banner", title: "Diwali banner", details: "Home page banner for Diwali week, please.", budget: 2000, startsOn: "2026-11-01", endsOn: "2026-11-07" };
check("a good request parses", parseMarketingRequest(mr, today), mr);
check("unknown kind refused", err(parseMarketingRequest({ ...mr, kind: "tv_ad" }, today)), "invalid_kind");
check("short details refused", err(parseMarketingRequest({ ...mr, details: "hi" }, today)), "invalid_details");
check("end before start refused", err(parseMarketingRequest({ ...mr, endsOn: "2026-10-30" }, today)), "invalid_dates");
check("start in the past refused", err(parseMarketingRequest({ ...mr, startsOn: "2026-10-01" }, today)), "in_the_past");
check("negative budget refused", err(parseMarketingRequest({ ...mr, budget: -5 }, today)), "invalid_budget");
check("no budget is fine", (parseMarketingRequest({ ...mr, budget: null }, today) as { budget: null }).budget, null);
check("pending → approved allowed", canMoveMarketing("pending", "approved"), true);
check("completed is final", canMoveMarketing("completed", "in_progress"), false);
check("approve before work starts (audited path, 0160)", canMoveMarketing("pending", "in_progress"), false);
check("an approved request is not rejected afterwards", canMoveMarketing("approved", "rejected"), false);
check("a cancelled request can't be revived", canMoveMarketing("cancelled", "approved"), false);
check("a rejection needs a reason", err(parseMarketingDecision({ status: "rejected" })), "remarks_required");
check("approve without remarks is fine", parseMarketingDecision({ status: "approved" }), { status: "approved", remarks: null });
check("admin can't set pending", err(parseMarketingDecision({ status: "pending" })), "invalid_status");

console.log("\n═══ Support tickets ═══");
const att = `${ME}/0d3c7d4e-8a8f-4b7e-9a51-2c3b4d5e6f70.jpg`;
check("own uploaded photo accepted", validAttachments([att], ME), [att]);
check("someone else's file refused", validAttachments([`99999999-2222-3333-4444-555555555555/0d3c7d4e-8a8f-4b7e-9a51-2c3b4d5e6f70.jpg`], ME), null);
check("path traversal refused", validAttachments([`${ME}/../x.jpg`], ME), null);
check("five photos refused", validAttachments([att, att, att, att, att], ME), null);
const t = parseTicket({ category: "payments", subject: "Payout missing", body: "Last week's payout hasn't arrived.", attachments: [att] }, ME);
check("a ticket parses", (t as { subject: string }).subject, "Payout missing");
check("unknown category refused", err(parseTicket({ category: "gossip", subject: "Hello", body: "x" }, ME)), "invalid_category");
check("a bad order id refused", err(parseTicket({ category: "orders", subject: "Late rider", body: "x", orderId: "1 or 1=1" }, ME)), "invalid_order");
check("a requester can't post an internal note", (parseTicketMessage({ body: "hi", internal: true }, ME) as { internal: boolean }).internal, false);
check("an admin can", (parseTicketMessage({ body: "check bank", internal: true }, ME, { allowInternal: true }) as { internal: boolean }).internal, true);
check("an empty reply refused", err(parseTicketMessage({ body: "   " }, ME)), "invalid_body");

console.log("\n═══ Announcements ═══");
check("an announcement parses", (parseAnnouncement({ audience: "vendor", title: "New payout day", body: "From next week payouts land on Tuesdays." }) as { push: boolean }).push, true);
check("unknown audience refused", err(parseAnnouncement({ audience: "customers", title: "Hello", body: "x" })), "invalid_audience");
check("end before start refused", err(parseAnnouncement({ audience: "all", title: "Hello", body: "x", startsAt: "2026-11-02T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" })), "invalid_dates");

console.log("\n═══ Customer insights ═══");
const o = (c: string | null, name: string | null, day: number, sale: number) => ({ customerId: c, customerName: name, createdAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`, sale });
const ins = customerInsights([o("a", "Asha Verma", 1, 300), o("a", "Asha Verma", 5, 200), o("a", "Asha Verma", 9, 400), o("b", "Ravi", 3, 100), o("c", "Neha Sahu", 4, 500), o("c", "Neha Sahu", 6, 100), o(null, null, 7, 200)]);
check("customers", ins.customers, 3);
check("repeat customers", ins.repeatCustomers, 2);
check("repeat rate %", ins.repeatRate, 66.7);
check("orders per customer", ins.ordersPerCustomer, 2);
check("average order value over all orders", ins.averageOrderValue, 257);
check("days between repeat orders", ins.daysBetweenOrders, 3.3);
check("best customer first, name shortened", ins.topCustomers[0], { name: "Asha V.", orders: 3, spent: 900, lastOrderAt: "2026-10-09T10:00:00Z" });
check("no orders, no division by zero", customerInsights([]).averageOrderValue, 0);
check("a one-word name stays", shortName("Ravi"), "Ravi");
check("no name", shortName(null), "Customer");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
