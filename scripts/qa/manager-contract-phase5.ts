/**
 * Phase 5 fixtures for the manager contract check: riders, money, cash and
 * delivery exceptions.
 *
 *   npm run test:manager-contract   (runs this after manager-contract-emit.ts)
 *
 * Unlike Phases 3 and 4, most rider shapes are assembled inside the data-access
 * functions rather than by pure serialisers, so this runs those functions
 * themselves against a seeded, in-memory PostgREST (and storage signer) and
 * writes exactly what each route sends to
 * `apps/manager/test/fixtures/api/generated/phase5/`. The app's
 * `test/contract_phase5_test.dart` then checks every key of its hand-written
 * fixtures is in these answers, with the same JSON type, and parses them.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const NOW = new Date("2026-10-21T08:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const Z1 = "5a5a5a5a-1111-4111-8111-000000000001";
const R = "5a5a5a5a-2222-4222-8222-000000000001"; // the rider
const M = "5a5a5a5a-3333-4333-8333-000000000001"; // the viewing manager
const M2 = "5a5a5a5a-3333-4333-8333-000000000002"; // the manager who asked for a payout
const S1 = "5a5a5a5a-4444-4444-8444-000000000001";
const O1 = "5a5a5a5a-5555-4555-8555-000000000001"; // an active order
const O2 = "5a5a5a5a-5555-4555-8555-000000000002"; // a delivered one
const C1 = "5a5a5a5a-6666-4666-8666-000000000001";
const P1 = "5a5a5a5a-7777-4777-8777-000000000001"; // a payout
const id = (n: number) => `5a5a5a5a-9999-4999-8999-${String(n).padStart(12, "0")}`;

const tables: Record<string, Row[]> = {
  staff_zones: [{ user_id: R, zone_id: Z1, delivery_zones: { name: "Bemetara" }, profiles: { role: "driver" } }],
  delivery_zones: [{ id: Z1, name: "Bemetara" }],
  profiles: [
    {
      id: R, full_name: "Ravi Kumar", phone: "+919800000007", avatar_url: null, role: "driver", account_status: "active",
      status_reason: null, status_changed_at: null, status_changed_by: null, created_at: ago(60 * 24 * 90),
    },
    { id: M, full_name: "Asha Verma", phone: null, role: "manager", created_at: ago(60 * 24 * 300) },
    { id: M2, full_name: "Vikram Sahu", phone: null, role: "manager", created_at: ago(60 * 24 * 300) },
  ],
  rider_profiles: [
    {
      driver_id: R, rider_code: "DR-0007", created_at: ago(60 * 24 * 90), verification_status: "verified", verified_at: ago(60 * 24 * 80),
      verified_by: M, vehicle_type: "ev_bike", vehicle_owner: "deligro", vehicle_registration: "CG-25-EV-0007",
      licence_number: "CG2520230001234", licence_expires_on: "2029-03-31", address_line: "Ward 4, Station Road", pincode: "491335",
      emergency_name: "Sunita Kumar", emergency_phone: "+919800000077", emergency_relation: "Sister",
    },
  ],
  rider_status: [
    { driver_id: R, is_online: true, break_until: null, online_since: ago(180), last_lat: 21.71, last_lng: 81.53, last_fix_at: ago(1) },
  ],
  rider_documents: [
    { id: id(1), driver_id: R, doc_type: "driving_licence", number: "CG2520230001234", expires_on: "2029-03-31", status: "verified", remarks: null, reviewed_by: M, reviewed_at: ago(60 * 24 * 80), created_at: ago(60 * 24 * 85), file_path: `${R}/driving_licence-1.jpg` },
    { id: id(2), driver_id: R, doc_type: "insurance", number: null, expires_on: "2026-11-05", status: "pending", remarks: null, reviewed_by: null, reviewed_at: null, created_at: ago(60 * 5), file_path: `${R}/insurance-2.pdf` },
  ],
  rider_ratings: [
    { id: id(10), driver_id: R, rating: 5, comment: "Quick and polite", created_at: ago(60 * 20), order_id: O2 },
    { id: id(11), driver_id: R, rating: 4, comment: null, created_at: ago(60 * 48), order_id: id(12) },
  ],
  orders: [
    { id: O2, status: "delivered", created_at: ago(60 * 22), zone_id: Z1, restaurant_id: S1, total: 420, address: { area: "Ward 4", line: "7 Station Road" }, cancelled_by: null, cancellation_reason: null },
    {
      id: O1, status: "kitchen", created_at: ago(14), accepted_at: ago(12), ready_at: null, cancelled_at: null, prep_minutes: 20,
      zone_id: Z1, restaurant_id: S1, total: 420, payment_method: "cod", payment_status: "pending", channel: "app",
      cancelled_by: null, cancellation_reason: null, address: { area: "Ward 9", line: "12 Gandhi Chowk", lat: 21.72, lng: 81.55 },
      restaurants: { id: S1, name: "Spice Hub", lat: 21.705, lng: 81.531, eta_min: 25, eta_max: 35 },
      order_items: [{ id: id(20) }, { id: id(21) }],
      customer: { full_name: "Neha Gupta" },
      deliveries: [{ status: "assigned", driver_id: R, picked_up_at: null, failed_at: null }],
    },
  ],
  deliveries: [
    { id: id(40), order_id: O1, driver_id: R, status: "assigned", assigned_at: ago(10) },
    { id: id(41), order_id: O2, driver_id: R, status: "delivered", assigned_at: ago(60 * 21), distance_km: "3.2", delivery_method: "code", failure_reason: null },
  ],
  restaurants: [{ id: S1, name: "Spice Hub" }],
  order_items: [{ id: id(22), order_id: O2, qty: 3 }],
  support_tickets: [
    { id: id(30), number: 412, subject: "Rider asked for change", category: "rider_behaviour", priority: "normal", status: "open", requester_role: "customer", requester_id: C1, order_id: O1, created_at: ago(30), updated_at: ago(30) },
  ],
  delivery_events: [
    { id: 1, delivery_id: id(41), order_id: O2, driver_id: R, kind: "accepted", method: null, reason: null, created_at: ago(60 * 21) },
    { id: 2, delivery_id: id(41), order_id: O2, driver_id: R, kind: "picked_up", method: "code", reason: null, created_at: ago(60 * 20 + 40) },
    { id: 3, delivery_id: id(41), order_id: O2, driver_id: R, kind: "delivered", method: "code", reason: null, created_at: ago(60 * 20 + 15) },
  ],
  rider_shifts: [],
  cash_deposits: [
    { id: id(40), driver_id: R, amount: 2400, method: "upi", reference: "UPI-881234", photo_path: `${R}/deposit-40.jpg`, note: "Morning shift", status: "submitted", decided_by: null, decided_at: null, decision_note: null, handover_id: null, created_at: ago(25) },
  ],
  cash_disputes: [
    { id: id(50), driver_id: R, day: "2026-10-20", claimed_amount: 1800, message: "I handed over 1800, not 1500", status: "open", resolution: null, resolved_at: null, created_at: ago(60 * 12) },
  ],
  delivery_exceptions: [
    { id: id(60), order_id: O1, driver_id: R, kind: "other_issue", reason: "Gate locked, guard not answering", notes: "Waited 10 minutes", photo_path: null, lat: 21.72, lng: 81.55, status: "pending", decided_by: null, decided_at: null, decision_note: null, created_at: ago(6) },
  ],
  payment_requests: [
    {
      id: id(70), kind: "rider_payout", subject_id: R, zone_id: Z1, amount: 12000, period_end: "2026-10-15", salary_amount: 12000,
      method: "bank", note: "October first half", status: "pending_approval", requested_by: M2, requested_at: ago(60 * 3),
      decided_by: null, decided_at: null, decision_note: null, reference: null, paid_on: null, result_id: null,
    },
  ],
  rider_earnings: [],
  rider_incentive_awards: [],
  rider_adjustments: [
    { id: id(80), driver_id: R, kind: "salary", amount: 12000, reason: "Salary, 1–15 Oct", order_id: null, effective_on: "2026-10-15", created_by: M2, payout_id: null },
    { id: id(81), driver_id: R, kind: "deduction", amount: 200, reason: "Helmet replacement", order_id: null, effective_on: "2026-10-10", created_by: M2, payout_id: P1 },
  ],
  rider_payouts: [
    { id: P1, driver_id: R, amount: 11800, method: "upi", reference: "UTR-55120", paid_on: "2026-10-01", period_end: "2026-09-30", request_id: null, created_at: ago(60 * 24 * 20) },
  ],
};
tables.ops_cash_deposits_scoped = tables.cash_deposits.map((r) => ({ ...r, rider_zone_ids: [Z1] }));
tables.ops_cash_disputes_scoped = tables.cash_disputes.map((r) => ({ ...r, rider_zone_ids: [Z1] }));
tables.ops_delivery_exceptions_scoped = tables.delivery_exceptions.map((r) => ({ ...r, rider_zone_ids: [Z1], order_zone_id: Z1 }));

const rpcs: Record<string, unknown> = {
  ops_rider_list_facts: [
    { driver_id: R, active_deliveries: 1, delivered_today: 9, rating_avg: "4.5", rating_count: 2, pending_docs: 1, expiring_docs: 1, open_complaints: 1 },
  ],
  ops_rider_money_summary: { pending: 12000, paid_total: 11800 },
  ops_rider_cash_position: { collected_today: 3100, deposited_today: 0, pending_deposit: 3100 },
  ops_rider_history: [
    {
      order_id: O2, row_key: "d:1", shop: "Spice Hub", drop_area: "Ward 4", outcome: "delivered", accepted_at: ago(60 * 21),
      picked_up_at: ago(60 * 20 + 40), delivered_at: ago(60 * 20 + 15), ended_at: ago(60 * 20 + 15), distance_km: "3.2",
      reason: null, cancelled_by: null, proof: "code", item_count: 3, order_value: 420,
    },
  ],
  ops_rider_history_totals: { delivered: 1, failed: 0, cancelled: 0, reassigned: 0 },
  ops_order_queue_facts: [],
};

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and"].includes(key) || key.includes(".")) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const arg = raw.slice(dot + 1);
    const value = row[key];
    const list = () => arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
    if (op === "eq" && String(value) !== arg) return false;
    if (op === "neq" && String(value) === arg) return false;
    if (op === "in" && !list().includes(String(value))) return false;
    if (op === "gte" && (value == null || String(value) < arg)) return false;
    if (op === "ov" && !(Array.isArray(value) && value.some((v) => list().includes(String(v))))) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(req.method === "HEAD" ? "" : JSON.stringify(obj));
    };
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      return send(200, { signedURL: `${url.pathname.replace("/storage/v1", "")}?token=test-token` });
    }
    const path = url.pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/")) return send(200, rpcs[path.slice(4)] ?? []);
    const rows = (tables[path] ?? []).filter((r) => matches(r, url));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 1000;
    const page = rows.slice(offset, offset + limit);
    send(200, page, { "content-range": `${offset}-${offset + page.length - 1}/${rows.length}` });
  });
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const riders = await import("../../src/lib/data-access/manager-riders");
  const { listCashDeposits, listCashDisputes } = await import("../../src/lib/data-access/manager-cash");
  const { listExceptions } = await import("../../src/lib/data-access/delivery-exceptions");
  const { listPaymentRequests } = await import("../../src/lib/data-access/payment-requests");
  const { parseRiderQuery, parseHistoryQuery, parseLedgerQuery } = await import("../../src/lib/ops/rider-contract");
  const { toRiderDocument } = await import("../../src/lib/ops/rider-rules");

  const scope = { all: false as const, zoneIds: [Z1] };
  const full: Record<string, boolean> = {
    "manager.riders.view": true, "manager.riders.status": true, "manager.riders.onboard": true, "manager.finance.view": true,
    "manager.finance.adjust": true, "manager.finance.initiate_payment": true, "manager.finance.approve_payment": true,
    "manager.assign_rider": true, "manager.reassign_rider": true, "manager.cash": true, "manager.exceptions.decide": true,
    "manager.call_customer": true,
  };
  const noMoney = { ...full, "manager.finance.view": false };
  const viewer = { id: M, perms: full, isAdmin: false };

  const q = <T>(p: { ok: true; query: T } | { ok: false; field: string }): T => {
    if (!p.ok) throw new Error(`query parse failed: ${p.field}`);
    return p.query;
  };

  const files: Record<string, unknown> = {
    riders_list: await riders.listRidersForManager(scope, q(parseRiderQuery(new URLSearchParams())), NOW),
    rider_detail: { rider: await riders.getRiderForManager(scope, R, viewer, NOW) },
    rider_detail_no_money: { rider: await riders.getRiderForManager(scope, R, { ...viewer, perms: noMoney }, NOW) },
    rider_history: await riders.getRiderHistoryForManager(scope, R, q(parseHistoryQuery(new URLSearchParams()))),
    rider_ledger: await riders.getRiderLedger(scope, R, q(parseLedgerQuery(new URLSearchParams()))),
    rider_ratings: await riders.getRiderRatingsPage(scope, R, null),
    // The upload route's answer (201 { document }), through its own serialiser.
    rider_document: {
      document: toRiderDocument({
        id: id(3), type: "photo", number: null, expiresOn: null, status: "pending", remarks: null,
        reviewedBy: null, reviewedAt: null, uploadedAt: NOW.toISOString(),
      }),
    },
    rider_document_url: await riders.riderDocumentUrlForManager(scope, R, id(2)),
    cash_deposits: await listCashDeposits(scope, { status: "submitted", rider: null, cursor: null }),
    cash_disputes: await listCashDisputes(scope, { status: "open", cursor: null }),
    exceptions: await listExceptions(scope, { status: "pending", rider: null, cursor: null }, full),
    payment_requests: await listPaymentRequests(scope, viewer, { status: null, kind: null, zone: null, mine: false, cursor: null }),
  };

  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  for (const [name, body] of Object.entries(files)) if (body === null || body === undefined) fail(`${name}: the reader returned nothing for a seeded rider`);
  const detail = (files.rider_detail as { rider: Record<string, unknown> | null }).rider;
  const detailNoMoney = (files.rider_detail_no_money as { rider: Record<string, unknown> | null }).rider;
  if (!detail || !("money" in detail)) fail("rider detail with manager.finance.view carries money");
  if (detailNoMoney && "money" in detailNoMoney) fail("rider detail without manager.finance.view has no money key");
  const active = (detail?.active ?? []) as { route: unknown[] }[];
  if (active.length !== 1 || active[0].route.length < 2) fail("an active delivery with a straight-line route is in the detail fixture");
  const history = files.rider_history as { items: Record<string, unknown>[] } | null;
  if (!history?.items.length || history.items.some((i) => "earning" in i)) fail("history items exist and carry no earning");
  const link = files.rider_document_url as { url?: string; expiresAt?: string } | null;
  if (!link?.url || !link.expiresAt) fail("a document link carries url and expiresAt");
  const disputes = files.cash_disputes as { counts?: { open: number } };
  if (disputes.counts?.open !== 1) fail("disputes carry counts.open");
  const exceptions = files.exceptions as { items: { kind: string }[] };
  if (exceptions.items[0]?.kind !== "other_issue") fail("exception kind is the stored other_issue");
  const requests = files.payment_requests as { items: { canDecide: boolean; requestedBy: { id: string } }[] };
  if (requests.items[0]?.requestedBy?.id !== M2 || requests.items[0]?.canDecide !== true) fail("a request by someone else is decidable by an approver");

  const out = join("apps", "manager", "test", "fixtures", "api", "generated", "phase5");
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote ${Object.keys(files).length} Phase 5 responses to ${out}`);

  server.close();
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`PASS phase 5 contract emit (${Object.keys(files).length} responses)`);
}

main().catch((e) => {
  console.error(`FAIL ${e instanceof Error ? e.stack : JSON.stringify(e)}`);
  server.close();
  process.exit(1);
});
