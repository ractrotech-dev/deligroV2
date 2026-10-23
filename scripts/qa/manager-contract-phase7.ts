/**
 * Phase 7 fixtures for the manager contract check: marketing requests and
 * campaigns, offers, customers and retention.
 *
 *   npm run test:manager-contract   (runs this after the Phase 3–6 emitters)
 *
 * Runs the readers the routes call (`listMarketingRequests`,
 * `getMarketingRequest`, `listCampaigns`, `getCampaign`, `listOffers`,
 * `getOffer`, `listCustomers`, `getCustomer`, `listCustomerComplaints`,
 * `listCustomerFeedback`, `getRetention`) against a seeded, in-memory
 * PostgREST and writes exactly what each route sends to
 * `apps/manager/test/fixtures/api/generated/phase7/`. The app's
 * `test/contract_phase7_test.dart` checks every key of its hand-written
 * fixtures is in these answers, with the same JSON type, and parses them.
 * `scripts/qa/manager-pii.ts` then scans the same files for personal data.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const NOW = new Date("2026-10-21T08:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const day = (n: number) => ago(n * 24 * 60);
const Z1 = "7b7b7b7b-1111-4111-8111-000000000001";
const S1 = "7b7b7b7b-2222-4222-8222-000000000001"; // Spice Hub
const S2 = "7b7b7b7b-2222-4222-8222-000000000002"; // Cafe Aroma
const R = "7b7b7b7b-3333-4333-8333-000000000001"; // a rider
const M = "7b7b7b7b-4444-4444-8444-000000000001"; // the viewing manager
const A = "7b7b7b7b-5555-4555-8555-000000000001"; // an admin
const V = "7b7b7b7b-5555-4555-8555-000000000002"; // a vendor owner
const C1 = "7b7b7b7b-6666-4666-8666-000000000001"; // customers
const C2 = "7b7b7b7b-6666-4666-8666-000000000002";
const id = (n: number) => `7b7b7b7b-9999-4999-8999-${String(n).padStart(12, "0")}`;
const REQ1 = id(1), REQ2 = id(2), REQ3 = id(3);
const CAMP1 = id(10), CAMP2 = id(11);
const BAN1 = id(20);
const I1 = id(30), I2 = id(31);
const O1 = id(40);
const T1 = id(50);
const ATTACH = `${REQ1}/poster.jpg`;

const requestRow = (rid: string, number: number, extra: Row = {}): Row => ({
  id: rid, number, restaurant_id: S1, zone_id: Z1, source: "vendor", kind: "featured", title: "Feature us this Diwali",
  details: "Top of the feed for the festival week.", starts_on: "2026-10-28", ends_on: "2026-11-03", budget: 5000,
  menu_item_ids: [], proposed_offer: null, attachment_path: null, status: "pending", admin_remarks: null,
  requested_by: V, decided_by: null, decided_at: null, campaign_id: null, offer_code: null,
  created_at: ago(180 + number), updated_at: ago(120 + number), ...extra,
});

const campaignRow = (cid: string, extra: Row = {}): Row => ({
  id: cid, kind: "featured_store", title: "Diwali featured shops", zone_id: Z1, restaurant_id: S1, status: "in_progress",
  starts_at: day(2), ends_at: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(), budget: 5000, funded_by: "vendor",
  vendor_share_pct: 100, slot_position: 1, banner_id: null, offer_code: null, request_id: REQ2, notes: "Top slot for the week",
  created_by: M, cancelled_reason: null, created_at: day(3), updated_at: day(2), ...extra,
});

const offerRow = (code: string, extra: Row = {}): Row => ({
  code, label: "Festive 20% off", kind: "percent", value: 20, min_order: 300, max_discount: 100, active: true,
  starts_at: day(10), expires_at: new Date(NOW.getTime() + 20 * 86_400_000).toISOString(), max_per_customer: 2, max_redemptions: 500,
  funded_by: "vendor", created_by: M, created_at: day(12), updated_at: day(1), vendor_ids: [S1], zone_ids: [Z1], item_ids: [],
  platform_wide: false, in_scope: true, redemptions: 14, discount_given: 1180, ...extra,
});

const ticket = (tid: string, number: number, extra: Row = {}): Row => ({
  id: tid, number, subject: "Order arrived cold", category: "food_quality", priority: "normal", status: "open",
  requester_role: "customer", order_id: O1, created_at: ago(1500), updated_at: ago(1400), requester_id: C1, zone_id: Z1, ...extra,
});

const tables: Record<string, Row[]> = {
  delivery_zones: [{ id: Z1, name: "Bemetara" }],
  restaurants: [{ id: S1, name: "Spice Hub", zone_id: Z1 }, { id: S2, name: "Cafe Aroma", zone_id: Z1 }],
  profiles: [
    { id: M, full_name: "Asha Verma", role: "manager" },
    { id: A, full_name: "Deligro Admin", role: "admin" },
    { id: V, full_name: "Mohan Lal", role: "restaurant" },
    { id: R, full_name: "Ravi Kumar", role: "driver" },
    { id: C1, full_name: "Neha Sharma", phone: "+919876543210", role: "customer", account_status: "active", status_reason: null,
      status_changed_by: null, status_changed_at: null, created_at: day(120) },
    { id: C2, full_name: "Imran Khan", phone: "+919811122233", role: "customer", account_status: "restricted",
      status_reason: "Three refused cash orders in a week", status_changed_by: M, status_changed_at: day(4), created_at: day(60) },
  ],
  menu_items: [{ id: I1, name: "Paneer Tikka" }, { id: I2, name: "Veg Biryani" }],
  marketing_requests: [
    requestRow(REQ1, 41, { attachment_path: ATTACH, menu_item_ids: [I1, I2], kind: "sponsored_product", title: "Push our paneer dishes" }),
    requestRow(REQ2, 42, { status: "approved", decided_by: M, decided_at: day(3), admin_remarks: "Approved for the festival week",
      campaign_id: CAMP1, offer_code: "FESTIVE20" }),
    requestRow(REQ3, 43, { kind: "discount_offer", title: "20% off for first-timers",
      proposed_offer: { kind: "percent", value: 20, minOrder: 300, maxDiscount: 100, maxPerCustomer: 1 }, source: "ops", requested_by: M }),
  ],
  campaigns: [
    campaignRow(CAMP1, { offer_code: "FESTIVE20" }),
    campaignRow(CAMP2, { kind: "banner", title: "Festival banner", status: "approved", banner_id: BAN1, request_id: null, funded_by: "shared",
      vendor_share_pct: 50, slot_position: null,
      starts_at: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), ends_at: new Date(NOW.getTime() + 10 * 86_400_000).toISOString() }),
  ],
  campaign_vendors: [{ campaign_id: CAMP1, restaurant_id: S1 }, { campaign_id: CAMP2, restaurant_id: S1 }, { campaign_id: CAMP2, restaurant_id: S2 }],
  campaign_items: [{ campaign_id: CAMP1, menu_item_id: I1 }],
  banners: [{ id: BAN1, headline: "Diwali at Spice Hub", description: "Festive thalis all week", cta_label: "Order now", target_type: "restaurant",
    target_value: S1, image_url: "https://cdn.example.test/banners/diwali.jpg", placements: ["home_top"] }],
  coupon_changes: [
    { id: 902, code: "FESTIVE20", created_at: day(1), actor_id: M, op: "update", target: "terms",
      before: { max_redemptions: 300, max_discount: 80 }, after: { max_redemptions: 500, max_discount: 100 }, reason: "Extended for the festival week" },
    { id: 901, code: "FESTIVE20", created_at: day(12), actor_id: M, op: "create", target: "terms", before: null,
      after: { kind: "percent", value: 20, min_order: 300 }, reason: null },
  ],
  support_tickets: [ticket(T1, 301), ticket(id(51), 302, { status: "resolved", subject: "Wrong item delivered", category: "wrong_item", created_at: ago(9000) })],
  reviews: [
    { id: id(60), user_id: C1, rating: 5, comment: "Great biryani", created_at: ago(2000), restaurant_id: S1, status: "published",
      orders: { short_code: "D7K2" }, review_replies: [{ reply_text: "Thank you!" }], review_flags: [] },
    { id: id(61), user_id: C1, rating: 2, comment: "Late and cold", created_at: ago(9000), restaurant_id: S2, status: "published",
      orders: { short_code: "H3M9" }, review_replies: [], review_flags: [{ id: id(65) }] },
  ],
  rider_ratings: [{ id: id(62), customer_id: C1, driver_id: R, rating: 4, comment: "Polite", created_at: ago(2000), order_id: O1 }],
  orders: [{ id: O1, short_code: "D7K2" }],
  rider_profiles: [{ driver_id: R, rider_code: "DR-0007" }],
  refunds: [{ id: id(70), status: "pending" }],
};

const rpcs: Record<string, unknown> = {
  ops_campaign_headlines: [
    { campaign_id: CAMP1, impressions: 4200, clicks: 310, attributed_orders: 58, attributed_sales: 17400 },
    { campaign_id: CAMP2, impressions: 0, clicks: 0, attributed_orders: 0, attributed_sales: 0 },
  ],
  ops_campaign_performance: {
    impressions: 4200, clicks: 310, redemptions: 14, discountGiven: 1180, attributedOrders: 58, attributedSales: 17400, attributedCustomers: 41,
    comparison: { beforeOrders: 40, beforeSales: 11800, duringOrders: 58, duringSales: 17400 },
    daily: [
      { date: "2026-10-19", impressions: 2000, clicks: 140, attributedOrders: 26, attributedSales: 7800 },
      { date: "2026-10-20", impressions: 2200, clicks: 170, attributedOrders: 32, attributedSales: 9600 },
    ],
  },
  ops_offer_rows: [
    offerRow("FESTIVE20"),
    offerRow("WELCOME50", { label: "₹50 off your first order", kind: "flat", value: 50, min_order: 250, max_discount: null, funded_by: "platform",
      vendor_ids: [], zone_ids: [Z1], platform_wide: false, max_per_customer: 1, max_redemptions: null, redemptions: 6, discount_given: 300 }),
  ],
  ops_offer_redemption_rows: [
    { order_id: O1, customer_id: C1, discount: 80, created_at: day(2), restaurant_id: S1, cancelled: false, order_total: 540, funded_by: "vendor", first_order: false },
    { order_id: id(41), customer_id: C2, discount: 100, created_at: day(3), restaurant_id: S1, cancelled: false, order_total: 780, funded_by: "vendor", first_order: true },
    { order_id: id(42), customer_id: C1, discount: 60, created_at: day(5), restaurant_id: S1, cancelled: true, order_total: 420, funded_by: "vendor", first_order: false },
  ],
  ops_customer_list: [
    { id: C1, full_name: "Neha Sharma", phone: "+919876543210", account_status: "active", member_since: day(120), orders: 24, spent: 11800,
      last_order_at: ago(1500), zone_ids: [Z1], sort_key: ago(1500) },
    { id: C2, full_name: "Imran Khan", phone: "+919811122233", account_status: "restricted", member_since: day(60), orders: 9, spent: 3900,
      last_order_at: day(6), zone_ids: [Z1], sort_key: day(6) },
  ],
  ops_customer_facts: {
    orders: 24, spent: 11800, cancelled: 2, firstOrderAt: day(118), lastOrderAt: ago(1500), zoneIds: [Z1],
    addressLines: ["12, Station Road, Bemetara", "Plot 4, Ward 7, Bemetara"],
  },
  ops_customer_order_facts: [
    { customer_id: C1, first_order_at: day(118), second_order_at: day(110), orders_in_range: 8, spent_in_range: 3900, last_order_at: ago(1500) },
    { customer_id: C2, first_order_at: day(60), second_order_at: day(50), orders_in_range: 5, spent_in_range: 2100, last_order_at: day(6) },
    { customer_id: id(80), first_order_at: day(20), second_order_at: null, orders_in_range: 1, spent_in_range: 350, last_order_at: day(20) },
  ],
};

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(key) || key.includes(".")) continue;
    const negate = raw.startsWith("not.");
    const spec = negate ? raw.slice(4) : raw;
    const dot = spec.indexOf(".");
    const op = spec.slice(0, dot);
    const arg = spec.slice(dot + 1);
    const value = row[key];
    const list = () => arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
    let hit = true;
    if (op === "eq") hit = String(value) === arg;
    else if (op === "neq") hit = String(value) !== arg;
    else if (op === "in") hit = list().includes(String(value));
    else if (op === "is") hit = arg === "null" ? value == null : String(value) === arg;
    else if (op === "gte") hit = value != null && String(value) >= arg;
    else if (op === "gt") hit = value != null && String(value) > arg;
    else if (op === "lte") hit = value != null && String(value) <= arg;
    else if (op === "lt") hit = value != null && String(value) < arg;
    if (negate ? hit : !hit) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(req.method === "HEAD" ? "" : JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { paths?: string[] };
      const bucket = url.pathname.slice("/storage/v1/object/sign/".length);
      return send(200, (body.paths ?? []).map((p) => ({ path: p, signedURL: `/object/sign/${bucket}/${p}?token=t`, error: null })));
    }
    const path = url.pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/")) return send(200, rpcs[path.slice(4)] ?? []);
    let rows = (tables[path] ?? []).filter((r) => matches(r, url));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 1000;
    const total = rows.length;
    rows = rows.slice(offset, offset + limit);
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    if (single) return rows.length ? send(200, rows[0]) : send(406, { code: "PGRST116", message: "no rows" });
    send(200, rows, { "content-range": `${offset}-${offset + rows.length - 1}/${total}` });
  });
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const mk = await import("../../src/lib/data-access/manager-marketing");
  const of = await import("../../src/lib/data-access/manager-offers");
  const cu = await import("../../src/lib/data-access/manager-customers");
  const { parseRequestQuery, parseCampaignQuery } = await import("../../src/lib/ops/marketing-contract");
  const { parseOfferQuery } = await import("../../src/lib/ops/offer-contract");
  const { parseCustomerQuery } = await import("../../src/lib/ops/customer-contract");

  const scope = { all: false as const, zoneIds: [Z1] };
  const ok = <T,>(q: { ok: true; q: T } | { ok: false; field: string }): T => {
    if (!q.ok) throw new Error(`query refused: ${q.field}`);
    return q.q;
  };
  const sp = (s = "") => new URLSearchParams(s);
  const permissions: Record<string, boolean> = { "manager.customers.view": true, "manager.customers.contact": true, "manager.customers.suspend": true };

  const files: Record<string, unknown> = {
    marketing_requests: await mk.listMarketingRequests(scope, ok(parseRequestQuery(sp()))),
    marketing_request_detail: await mk.getMarketingRequest(scope, REQ1, NOW),
    campaigns_list: await mk.listCampaigns(scope, ok(parseCampaignQuery(sp("state=all"))), NOW),
    campaign_detail: await mk.getCampaign(scope, CAMP1, NOW, null),
    offers_list: await of.listOffers(scope, ok(parseOfferQuery(sp("state=all"))), NOW),
    offer_detail: await of.getOffer(scope, "FESTIVE20", null, NOW, false),
    customers_list: await cu.listCustomers(scope, ok(parseCustomerQuery(sp()))),
    customer_detail: { customer: await cu.getCustomer(scope, C1, permissions) },
    customer_complaints: await cu.listCustomerComplaints(scope, C1, null),
    customer_feedback: await cu.listCustomerFeedback(scope, C1, null),
  };
  const range = { from: "2026-07-24", to: "2026-10-21" };
  files.retention = { ...range, ...(await cu.getRetention(scope, range)) };

  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  for (const [name, body] of Object.entries(files)) if (body === null || body === undefined) fail(`${name}: the reader returned nothing for seeded rows`);

  const reqs = files.marketing_requests as { items: { id: string }[]; counts: Record<string, number> };
  if (reqs.items.length !== 3) fail("all three seeded requests are listed");
  if (reqs.counts.pending !== 2) fail("the status counts add up");
  const detail = files.marketing_request_detail as { request: { attachmentUrl: string | null } } | null;
  if (!detail?.request.attachmentUrl) fail("a request attachment carries a signed link");
  const camp = files.campaign_detail as { performance: { from: string; to: string; ctr: number } } | null;
  if (!camp || !(camp.performance.ctr > 0)) fail("campaign performance has a click-through rate");
  const offer = files.offer_detail as { usage: { byVendor: { vendor: { name: string } }[] }; changes: { fields: unknown[] }[] } | null;
  if (!offer?.changes.some((c) => c.fields.length > 0)) fail("an offer change carries a field diff");
  if (JSON.stringify(offer?.usage ?? {}).includes(C1)) fail("offer usage never names a customer");
  const customers = files.customers_list as { items: Record<string, unknown>[] };
  for (const c of customers.items) {
    if ("phone" in c || "email" in c) fail("a customer list row carries no raw phone or email");
    if (typeof c.phoneMasked !== "string" || !String(c.phoneMasked).includes("•") && !String(c.phoneMasked).includes("*") && !String(c.phoneMasked).includes("X") && !String(c.phoneMasked).includes("x")) {
      fail(`a customer's phone is masked (got ${String(c.phoneMasked)})`);
    }
  }
  const blob = JSON.stringify(files);
  if (blob.includes("9876543210") || blob.includes("9811122233")) fail("no raw customer phone number in any Phase 7 answer");
  if (/[ऀ-ॿ]/.test(blob) || blob.includes("labelHi")) fail("no Hindi in any Phase 7 answer");

  const out = join(process.cwd(), "apps/manager/test/fixtures/api/generated/phase7");
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + "\n");
  server.close();

  if (failures.length) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`\nphase 7 contract: ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`phase 7 contract: wrote ${Object.keys(files).length} answers to ${out}`);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
