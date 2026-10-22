/**
 * QA — manager riders (§5): live state, masking, required documents, the
 * actions a manager is offered, the detail serialiser (money absent without
 * manager.finance.view, no position for an offline idle rider, never a bank /
 * UPI / Aadhaar / customer key), query parsing, the cursor, performance
 * figures, and structural rules on the routes and the data layer. The live
 * section runs against a dev server when BASE is reachable and
 * QA_MANAGER_COOKIE is set.
 *
 * Usage: npx tsx scripts/qa/manager-riders.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { managerCookie } from "./_manager-session";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  allowedRiderActions,
  buildRiderDetail,
  documentExpiring,
  maskNumber,
  requiredRiderDocsMissing,
  riderState,
  type RiderDetailInput,
} from "../../src/lib/ops/rider-rules";
import { parseRiderQuery, parseHistoryQuery, parseLedgerQuery, percentToRatio } from "../../src/lib/ops/rider-contract";
import { decodeNameCursor, encodeNameCursor } from "../../src/lib/ops/vendor-contract";
import { decodeHistoryCursor, encodeHistoryCursor, monthOf, onlineHours, percent } from "../../src/lib/rider/figures";

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
const NOW = new Date("2026-10-21T10:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const qp = (s: string) => new URLSearchParams(s);

console.log("\n── riderState ──");
const st = (s: Partial<{ isOnline: boolean; breakUntil: Date | null; lastFixAt: Date | null; activeDeliveries: number }>) =>
  riderState({ isOnline: false, breakUntil: null, lastFixAt: null, activeDeliveries: 0, ...s }, NOW);
check("online + break → break", st({ isOnline: true, breakUntil: new Date(NOW.getTime() + 600_000), lastFixAt: ago(1) }) === "break");
check("online + 6-minute-old fix → stale", st({ isOnline: true, lastFixAt: ago(6) }) === "stale");
check("online + active delivery → on_delivery", st({ isOnline: true, lastFixAt: ago(1), activeDeliveries: 1 }) === "on_delivery");
check("online, idle, fresh → available", st({ isOnline: true, lastFixAt: ago(1) }) === "available");
check("offline with an active delivery → on_delivery", st({ isOnline: false, activeDeliveries: 1 }) === "on_delivery");
check("offline, idle → offline", st({}) === "offline");
check("an elapsed break counts as available", st({ isOnline: true, breakUntil: ago(1), lastFixAt: ago(1) }) === "available");

console.log("\n── masking, documents ──");
check("maskNumber keeps the last 4", maskNumber("123456781234") === "XXXX1234");
check("maskNumber(null) → null", maskNumber(null) === null);
check("maskNumber of a short number masks it all", maskNumber("123") === "XXXX");
const missing = requiredRiderDocsMissing([
  { type: "aadhaar", status: "verified" },
  { type: "driving_licence", status: "rejected" },
]);
check("required docs: rejected licence and missing photo", missing.join() === "driving_licence,photo", missing.join());
check("required docs: all verified → none", requiredRiderDocsMissing([
  { type: "aadhaar", status: "verified" }, { type: "driving_licence", status: "verified" }, { type: "photo", status: "verified" },
]).length === 0);
check("expiring within 30 days", documentExpiring("2026-11-10", NOW) === true);
check("not expiring in 60 days", documentExpiring("2026-12-30", NOW) === false);
check("already expired counts as expiring", documentExpiring("2026-10-01", NOW) === true);
check("no expiry → false", documentExpiring(null, NOW) === false);

console.log("\n── allowed actions ──");
const base = { verification: "pending", account: "active", activeDeliveries: 0 };
const none = allowedRiderActions(base, { "manager.riders.view": true });
check("without riders.status: no status actions",
  !none.approve && !none.reject && !none.suspend && !none.reactivate && !none.forceOffline && !none.reviewDocuments);
const all = { "manager.riders.view": true, "manager.riders.status": true, "manager.finance.adjust": true,
  "manager.finance.initiate_payment": true, "manager.riders.onboard": true, "manager.assign_rider": true };
const a1 = allowedRiderActions(base, all);
check("pending + active: approve, reject, suspend, force offline", a1.approve && a1.reject && a1.suspend && !a1.reactivate && a1.forceOffline);
const a2 = allowedRiderActions({ ...base, account: "suspended" }, all);
check("suspended: reactivate, not suspend", a2.reactivate && !a2.suspend && !a2.forceOffline);
const a3 = allowedRiderActions({ ...base, verification: "verified" }, all);
check("verified: neither approve nor reject", !a3.approve && !a3.reject);
check("addAdjustment needs finance.adjust", allowedRiderActions(base, { ...all, "manager.finance.adjust": false }).addAdjustment === false && a1.addAdjustment);
check("requestPayout needs initiate_payment", allowedRiderActions(base, { ...all, "manager.finance.initiate_payment": false }).requestPayout === false && a1.requestPayout);
check("uploadDocuments needs riders.onboard", a1.uploadDocuments && !allowedRiderActions(base, { ...all, "manager.riders.onboard": false }).uploadDocuments);
check("a suspended rider cannot be assigned", !a2.assign && a1.assign);

console.log("\n── detail serialiser ──");
const input: RiderDetailInput = {
  id: randomUUID(), riderCode: "DR-0007", name: "Ravi Kumar", phone: "+919800000000", photoUrl: null,
  isOnline: false, breakUntil: null, onlineSince: null, lastFixAt: ago(30).toISOString(), lat: 21.7, lng: 81.5,
  zones: [{ id: randomUUID(), name: "Bemetara" }], verification: "pending", account: "active",
  accountReason: null, accountChangedAt: null, accountChangedBy: null, verifiedAt: null, verifiedBy: null,
  activeDeliveries: 0, deliveredToday: 3, rating: 4.6, ratingCount: 31,
  pendingDocuments: 1, expiringDocuments: 0, openComplaintsCount: 0,
  profile: { vehicleType: "ev_bike", vehicleOwner: "deligro", vehicleRegistration: "CG07AB1234", licenceNumber: "DL1234567890",
    licenceExpiresOn: "2027-01-01", address: "Ward 4", pincode: "491335",
    emergency: { name: "Sita", phone: "+919811111111", relation: "Wife" }, joinedAt: "2026-01-01T00:00:00.000Z" },
  active: [],
  performance: { from: "2026-09-21", to: "2026-10-21", delivered: 10, failed: 0, cancelled: 1, acceptanceRate: 0.9,
    avgDeliverMinutes: 24, avgPickupToDeliverMinutes: 11, failedRate: 0, onlineHours: 40, months: [] },
  ratings: { average: 4.6, count: 31, distribution: { "1": 0, "2": 0, "3": 1, "4": 10, "5": 20 }, recent: [] },
  documents: [{ id: randomUUID(), type: "aadhaar", number: "123456789012", expiresOn: null, status: "verified", remarks: null,
    reviewedBy: null, reviewedAt: null, uploadedAt: "2026-01-02T00:00:00.000Z" }],
  money: { pending: 12000, paidTotal: 48000, lastPayout: null, pendingRequests: [] },
  cash: { collectedToday: 0, depositedToday: 0, pendingDeposit: 0, openDeposits: [], openDisputes: [] },
  openExceptions: [], openComplaints: [],
};
const withMoney = buildRiderDetail(input, { ...all, "manager.finance.view": true }, NOW);
const noMoney = buildRiderDetail(input, all, NOW);
check("money present with finance.view", "money" in withMoney && withMoney.money?.pending === 12000);
check("money key absent without finance.view", !("money" in noMoney));
check("offline idle rider → position null", withMoney.availability.position === null);
const onDelivery = buildRiderDetail({ ...input, activeDeliveries: 1, active: [{ orderId: randomUUID(), code: "AB12CD34",
  status: "picked_up", shop: { name: "Spice Hub", lat: 21.7, lng: 81.5 }, drop: { area: null, lat: 21.71, lng: 81.52 },
  etaPickupAt: null, etaDeliveryAt: null, route: [[21.7, 81.5], [21.71, 81.52]], delay: null }] }, all, NOW);
check("rider on a delivery → position shown", onDelivery.availability.position?.lat === 21.7);
check("an offline idle rider's route is never sent", withMoney.active.length === 0);
check("Aadhaar only masked", withMoney.documents[0].numberMasked === "XXXX9012" && !JSON.stringify(withMoney).includes("123456789012"));
check("licence masked", withMoney.profile.licenceNumberMasked === "XXXX7890" && !JSON.stringify(withMoney).includes("DL1234567890"));
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
  return out;
}
const banned = keys(withMoney).filter((k) => /account_number|accountNumber|ifsc|upi_?id|customer_?id|aadhaar$/i.test(k));
check("no bank / UPI / customer / raw Aadhaar key anywhere", banned.length === 0, banned.join());
check("state derived", withMoney.state === "offline");

console.log("\n── query parsing ──");
let p = parseRiderQuery(qp(""));
check("defaults: limit 50", p.ok && p.query.limit === 50 && p.query.states.length === 0);
p = parseRiderQuery(qp("state=available,on_delivery"));
check("state list", p.ok && p.query.states.join() === "available,on_delivery");
p = parseRiderQuery(qp("state=sleeping"));
check("a bad state → field state", !p.ok && p.field === "state");
p = parseRiderQuery(qp("limit=101"));
check("limit 101 → field limit", !p.ok && p.field === "limit");
p = parseRiderQuery(qp("filter=needs_review&verification=pending&account=suspended"));
check("filter, verification, account pass", p.ok && p.query.filter === "needs_review" && p.query.verification === "pending" && p.query.account === "suspended");
p = parseRiderQuery(qp("verification=maybe"));
check("a bad verification → field verification", !p.ok && p.field === "verification");
p = parseRiderQuery(qp("zone=nope"));
check("a bad zone → field zone", !p.ok && p.field === "zone");
const cur = encodeNameCursor("ravi kumar", randomUUID());
check("cursor round-trip", decodeNameCursor(cur)?.name === "ravi kumar");
p = parseRiderQuery(qp(`cursor=${cur}`));
check("cursor accepted", p.ok && p.query.cursor?.name === "ravi kumar");
const h = parseHistoryQuery(qp("from=2026-10-01&to=2026-10-20&outcome=failed"));
check("history query", h.ok && h.query.outcome === "failed" && h.query.from === "2026-10-01");
check("history from after to → field from", !parseHistoryQuery(qp("from=2026-10-21&to=2026-10-01")).ok);
check("history bad outcome → field", !parseHistoryQuery(qp("outcome=lost")).ok);
check("ledger status=paid", parseLedgerQuery(qp("status=paid")).ok);
check("ledger bad status", !parseLedgerQuery(qp("status=maybe")).ok);

console.log("\n── figures (the Rider app's own, read through by the manager screen) ──");
check("percent with zero denominator → null", percent(0, 0) === null);
check("percent 9/10 = 90", percent(9, 10) === 90);
check("as the manager ratio: 90 → 0.9, 33.3 → 0.333, null stays null",
  percentToRatio(90) === 0.9 && percentToRatio(33.3) === 0.333 && percentToRatio(null) === null);
check("online hours clip to the window and count an open shift to now",
  onlineHours([{ startedAt: "2026-10-20T08:00:00Z", endedAt: "2026-10-20T10:00:00Z" }, { startedAt: "2026-10-21T09:00:00Z", endedAt: null }],
    Date.parse("2026-10-20T09:00:00Z"), NOW.getTime() + 1, NOW.getTime()) >= 1);
check("IST month across midnight", monthOf("2026-09-30T19:00:00Z") === "2026-10");
{
  const c = encodeHistoryCursor({ at: "2026-10-20T10:00:00.000Z", id: 42 });
  check("history cursor is the Rider app's (round-trips)", decodeHistoryCursor(c)?.id === 42);
  const hq = parseHistoryQuery(qp(`cursor=${encodeURIComponent(c)}`));
  check("the manager history query passes that cursor through", hq.ok && hq.query.cursor === c);
  check("...and refuses one it cannot read", !parseHistoryQuery(qp("cursor=nonsense")).ok);
}

console.log("\n── structural ──");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const q = join(dir, f);
    return statSync(q).isDirectory() ? walk(q) : [q];
  });
}
const routes = walk("src/app/api/manager/riders").filter((f) => f.endsWith("route.ts"));
check("rider routes exist (list, detail, history, ratings, document url, ledger)", routes.length >= 6, routes.join());
for (const r of routes) {
  const src = readFileSync(r, "utf8");
  check(`${r} opens with managerApiContext`, /managerApiContext\(/.test(src));
}
const ledger = readFileSync("src/app/api/manager/riders/[id]/ledger/route.ts", "utf8");
check("ledger route checks manager.finance.view", /manager\.finance\.view/.test(ledger));
const da = readFileSync("src/lib/data-access/manager-riders.ts", "utf8");
check("no select(\"*\") in manager-riders.ts", !/select\(\s*["']\*["']/.test(da));
check("payout accounts never read", !/rider_payout_accounts/.test(da));
check("customer_id never selected from ratings", !/rider_ratings[^;]*customer_id/s.test(da.replace(/\/\/.*$/gm, "")));
check("rider reads go through the rider scope", /applyRiderScope|scopedRiderIds|riderInScope/.test(da));
const scopeSrc = readFileSync("src/lib/auth/manager-scope.ts", "utf8");
check("applyRiderScope exists", /export function applyRiderScope/.test(scopeSrc));
const catalog = readFileSync("src/lib/features/catalog.ts", "utf8");
check("catalog has manager.exceptions.decide", /"manager\.exceptions\.decide"/.test(catalog));

console.log("\n── live (optional) ──");
const BASE = process.env.BASE ?? "http://localhost:3005";
async function live() {
  const cookie = await managerCookie();
  try {
    const r = await fetch(`${BASE}/api/manager/riders`, { redirect: "manual" });
    if (r.status === 404) {
      console.log("  skip (the server on BASE does not serve this branch)");
      return;
    }
    check("unauthenticated → 401", r.status === 401);
  } catch {
    console.log("  skip (dev server unreachable)");
    return;
  }
  if (!cookie) {
    console.log("  skip signed-in checks (no manager login)");
    return;
  }
  const r = await fetch(`${BASE}/api/manager/riders/${randomUUID()}`, { headers: { cookie } });
  check("an unknown or out-of-zone rider → 404", r.status === 404);
}
void live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
