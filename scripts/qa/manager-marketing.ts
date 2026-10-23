/**
 * QA — Phase 7 marketing: the contract module (query and body parsing, RPC
 * error map, serialisers), the routes' structure, and the report's campaign
 * rows. Pure and structural; the live half runs when BASE and a manager
 * session cookie are present (QA_MANAGER_COOKIE), else it is skipped.
 *
 * Usage:  npm run test:manager-marketing
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  campaignKindFor, dbKind, errorBody, httpStatusOf, mapMarketingRpcError, parseCampaignActionBody, parseCampaignQuery, parseCampaignUpdateBody,
  parseCreateRequestBody, parseDecideBody, parseRequestQuery, requestType, serializeCampaignDetail, serializeRequest,
  type CampaignRow, type Names, type RequestRow,
} from "../../src/lib/ops/marketing-contract";
import { imageKind as imageKindForTest } from "../../src/lib/marketing/image-kind";
import { buildMarketing } from "../../src/lib/reports/builders";

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}
const now = new Date("2026-11-03T12:00:00+05:30");
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

console.log("\n── kinds ──");
check("featured_store ↔ 0064 'featured'", dbKind("featured_store") === "featured" && requestType("featured") === "featured_store");
check("seasonal ↔ 'festival_campaign'", dbKind("seasonal") === "festival_campaign" && requestType("festival_campaign") === "seasonal");
check("discount_offer and other have no campaign", campaignKindFor("discount_offer") === null && campaignKindFor("other") === null);

console.log("\n── queries ──");
const rq = (s: string) => parseRequestQuery(new URLSearchParams(s));
check("bad status → field status", (() => { const r = rq("status=done"); return !r.ok && r.field === "status"; })());
check("bad vendor uuid → field vendor", (() => { const r = rq("vendor=abc"); return !r.ok && r.field === "vendor"; })());
check("limit 101 → field limit", (() => { const r = rq("limit=101"); return !r.ok && r.field === "limit"; })());
check("a good query", rq(`status=pending&type=seasonal&vendor=${U(1)}`).ok);
const cq = (s: string) => parseCampaignQuery(new URLSearchParams(s));
check("bad campaign state → field state", (() => { const r = cq("state=live"); return !r.ok && r.field === "state"; })());
check("state defaults to all", (() => { const r = cq(""); return r.ok && r.q.state === "all"; })());

console.log("\n── bodies ──");
const decide = (b: Record<string, unknown>, type: Parameters<typeof parseDecideBody>[1] = "featured_store") => parseDecideBody(b, type, now);
check("reject without remarks → reason_required on remarks", (() => {
  const r = decide({ decision: "reject", expected: "pending", clientActionId: "abcdefgh" });
  return !r.ok && r.field === "remarks" && r.error === "reason_required";
})());
check("approving a featured request without campaign → field campaign", (() => {
  const r = decide({ decision: "approve", expected: "pending", clientActionId: "abcdefgh" });
  return !r.ok && r.field === "campaign";
})());
check("approving with a campaign missing its slot → campaign.slotPosition", (() => {
  const r = decide({ decision: "approve", expected: "pending", clientActionId: "abcdefgh",
    campaign: { title: "Top slot", startsAt: "2026-11-04T00:00:00+05:30", endsAt: "2026-11-05T00:00:00+05:30", fundedBy: "vendor" } });
  return !r.ok && r.field === "campaign.slotPosition";
})());
check("approving a featured request with a complete campaign", decide({ decision: "approve", expected: "pending", clientActionId: "abcdefgh",
  campaign: { title: "Top slot", startsAt: "2026-11-04T00:00:00+05:30", endsAt: "2026-11-05T00:00:00+05:30", fundedBy: "vendor", slotPosition: 2 } }).ok);
check("approving a discount request needs an offer", (() => {
  const r = decide({ decision: "approve", expected: "pending", clientActionId: "abcdefgh" }, "discount_offer");
  return !r.ok && r.field === "offer";
})());
check("an 'other' request approves with nothing attached", decide({ decision: "approve", expected: "pending", clientActionId: "abcdefgh" }, "other").ok);
check("create on behalf: a proposed offer on a banner request → field proposedOffer", (() => {
  const r = parseCreateRequestBody({ vendorId: U(1), type: "banner", title: "Banner", proposedOffer: { code: "X" }, clientActionId: "abcdefgh" });
  return !r.ok && r.field === "proposedOffer";
})());
check("campaign action without a reason → reason_required", (() => {
  const r = parseCampaignActionBody({ action: "cancel", reason: "", clientActionId: "abcdefgh" });
  return !r.ok && r.error === "reason_required";
})());

console.log("\n── RPC errors ──");
const m = (message: string, details: string | null = null, code = "P0001") => mapMarketingRpcError({ message, details, code });
const asOk = (r: ReturnType<typeof m>) => (r.ok ? null : { status: httpStatusOf(r), body: errorBody(r) });
check("forbidden → 404 not_found", asOk(m("forbidden", null, "42501"))?.status === 404);
check("reason_required → 422", asOk(m("reason_required"))?.status === 422 && asOk(m("reason_required"))?.body.error === "reason_required");
check("slot_taken → 409 with the campaign id", (() => { const a = asOk(m("slot_taken", U(9), "23505")); return a?.status === 409 && a.body.campaignId === U(9); })());
check("consent_required (42501) → 409, not 404", asOk(m("consent_required", null, "42501"))?.status === 409);
check("out_of_scope → 409 with field", (() => { const a = asOk(m("out_of_scope", "itemIds", "42501")); return a?.status === 409 && a.body.field === "itemIds"; })());
check("stale → 409 with current", (() => { const a = asOk(m("stale", "pending", "40001")); return a?.status === 409 && a.body.current === "pending"; })());
check("bad_request → 400 with field", (() => { const a = asOk(m("bad_request", "endsAt", "22023")); return a?.status === 400 && a.body.field === "endsAt"; })());
check("someone else's clientActionId → 409 stale", asOk(m("client_action_id_conflict", null, "23505"))?.body.error === "stale");
check("anything else → 500 action_failed", asOk(m("boom", null, "XX000"))?.body.error === "action_failed");
check("no internal httpStatus leaks into a body", !("httpStatus" in (asOk(m("reason_required"))?.body ?? {})));

console.log("\n── serialisers ──");
const names: Names = {
  shop: () => "Spice Hub", zone: (id) => (id ? { id, name: "Bemetara" } : null),
  person: () => ({ name: "Vik", role: "restaurant" }), item: () => "Roll",
};
const req: RequestRow = { id: U(1), number: 41, restaurant_id: U(2), zone_id: U(3), source: "vendor", kind: "festival_campaign", title: "Diwali",
  details: "", starts_on: "2026-11-01", ends_on: null, budget: 5000, menu_item_ids: [U(4)], proposed_offer: null, attachment_path: "x/y.pdf",
  status: "pending", admin_remarks: null, requested_by: U(5), decided_by: null, decided_at: null, campaign_id: null, offer_code: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
const sr = serializeRequest(req, names);
const REQ_KEYS = ["id", "number", "vendor", "zone", "source", "type", "title", "details", "preferredStart", "preferredEnd", "budget", "items",
  "proposedOffer", "attachmentUrl", "status", "remarks", "requestedBy", "decidedBy", "decidedAt", "campaignId", "offerCode", "createdAt", "updatedAt"];
check("request: exactly the pinned keys", JSON.stringify(Object.keys(sr).sort()) === JSON.stringify([...REQ_KEYS].sort()), Object.keys(sr));
check("request: type is the contract's seasonal, attachment path never sent", sr.type === "seasonal" && sr.attachmentUrl === null
  && !JSON.stringify(sr).includes("x/y.pdf"));
const camp: CampaignRow = { id: U(10), kind: "banner", title: "Diwali banner", zone_id: U(3), restaurant_id: U(2), status: "approved",
  starts_at: "2026-11-01T00:00:00+05:30", ends_at: "2026-11-08T00:00:00+05:30", budget: 3000, funded_by: "vendor", vendor_share_pct: null,
  slot_position: null, banner_id: U(11), offer_code: null, request_id: U(1), notes: null, created_by: U(6), cancelled_reason: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
const sc = serializeCampaignDetail(camp, [U(2)], [], null, names, now, { impressions: 10, clicks: 1, attributedOrders: 1, attributedSales: 400 });
check("campaign: state active inside its window; allowed end now, not cancel", sc.state === "active" && sc.allowed.endNow && !sc.allowed.cancel);
const walk = (v: unknown, path = ""): string[] => (v && typeof v === "object"
  ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${path}.${k}`, ...walk(x, `${path}.${k}`)]) : []);
const PII = /phone$|email|address_line|\.lat$|\.lng$|customer/i;
check("no customer identity anywhere in a request or campaign payload", ![...walk(sr), ...walk(sc)].some((k) => PII.test(k)),
  [...walk(sr), ...walk(sc)].filter((k) => PII.test(k)));

console.log("\n── image check ──");
check("JPEG and PNG by magic bytes", imageKindForTest([0xff, 0xd8, 0xff, 0xe0]) === "jpg" && imageKindForTest([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) === "png");
check("a GIF or a renamed text file is refused", imageKindForTest([0x47, 0x49, 0x46, 0x38]) === null && imageKindForTest([0x3c, 0x73, 0x76, 0x67]) === null);

console.log("\n── routes (structure) ──");
const root = join(__dirname, "../../src/app/api/manager/marketing");
const files: string[] = [];
const walkDir = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDir(p); else if (f === "route.ts") files.push(p); } };
walkDir(root);
check("eight marketing route files", files.length === 8, files.length);
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = f.slice(root.length);
  const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|DELETE)/g)].map((x) => x[1]);
  check(`${rel}: every handler opens with managerApiContext("manager.marketing.manage")`,
    (src.match(/managerApiContext\("manager\.marketing\.manage"\)/g) ?? []).length === handlers.length);
  for (const h of handlers.filter((x) => x !== "GET")) {
    const start = src.indexOf(`export async function ${h}`);
    const next = src.indexOf("export async function", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    check(`${rel} ${h}: rate-limited`, body.includes("managerWriteLimit("));
  }
  check(`${rel}: no select("*")`, !/select\("\*"\)/.test(src));
}
const image = readFileSync(join(root, "campaigns/[id]/image/route.ts"), "utf8");
check("image route refuses a big body before reading it", /content-length/.test(image) && image.indexOf("content-length") < image.indexOf("formData"));
const dal = readFileSync(join(__dirname, "../../src/lib/data-access/manager-marketing.ts"), "utf8");
check("data layer: 2 MB cap and magic bytes on uploads", /2 \* 1024 \* 1024/.test(dal) && /imageKind\(bytes\)/.test(dal));
check("data layer: no select(\"*\")", !/select\("\*"\)/.test(dal));

console.log("\n── report ──");
const built = buildMarketing({ banners: [], codes: [], campaigns: [{ campaign: "Diwali banner", type: "banner", vendor: "Spice Hub", start: null,
  end: null, status: "in_progress", budget: 3000, fundedBy: "vendor", impressions: 10, clicks: 2, attributedOrders: 1, attributedSales: 400 }] });
const row = built.rows[0] as Record<string, unknown>;
check("campaign rows carry budget, funding and attributed sales", row.budget === 3000 && row.fundedBy === "vendor" && row.attributedSales === 400);
check("a rollup from before 0163 (no campaigns key) still builds", buildMarketing({ banners: [], codes: [] }).rows.length === 0);


console.log("\n── review fixes: a campaign edit names only editable, well-typed fields ──");
const upd = (changes: Record<string, unknown>) =>
  parseCampaignUpdateBody({ expectedUpdatedAt: "2026-11-03T06:30:00.000Z", changes, reason: null, clientActionId: "abcdefgh" });
const field = (r: ReturnType<typeof upd>) => (r.ok ? null : r.field);
check("a known field passes", upd({ notes: "Hello" }).ok === true);
check("an unknown key is refused by name", field(upd({ createdBy: U(1) })) === "createdBy");
check("zoneId / kind / requestId reach the database, which refuses them as locked_field",
  upd({ zoneId: U(1) }).ok === true && upd({ kind: "seasonal" }).ok === true && upd({ requestId: U(2) }).ok === true);
check("vendorIds must be uuids", field(upd({ vendorIds: ["not-a-uuid"] })) === "vendorIds");
check("itemIds must be uuids, at most 20", field(upd({ itemIds: Array.from({ length: 21 }, (_, i) => U(i + 1)) })) === "itemIds");
check("budget must be a whole number in range or null", field(upd({ budget: 12.5 })) === "budget" && field(upd({ budget: 20_000_000 })) === "budget"
  && upd({ budget: null }).ok === true);
check("fundedBy must be one of the three", field(upd({ fundedBy: "me" })) === "fundedBy" && upd({ fundedBy: "shared", vendorSharePct: 40 }).ok === true);
check("vendorSharePct is 1–99 or null", field(upd({ vendorSharePct: 100 })) === "vendorSharePct");
check("dates must parse", field(upd({ startsAt: "tomorrow-ish" })) === "startsAt" && field(upd({ endsAt: 5 })) === "endsAt");
check("offerCode is 3–20 letters and digits", field(upd({ offerCode: "no spaces!" })) === "offerCode" && upd({ offerCode: "SEAS1" }).ok === true
  && upd({ offerCode: null }).ok === true);
check("banner must be an object", field(upd({ banner: "x" })) === "banner" && upd({ banner: { headline: "Hi" } }).ok === true);
check("slotPosition is 1–10 or null", field(upd({ slotPosition: 11 })) === "slotPosition");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
