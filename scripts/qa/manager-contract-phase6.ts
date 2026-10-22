/**
 * Phase 6 fixtures for the manager contract check: finance and reports.
 *
 *   npm run test:manager-contract   (runs this after the Phase 3–5 emitters)
 *
 * Runs the finance readers and the report registry themselves against a
 * seeded, in-memory PostgREST and writes exactly what each route sends to
 * `apps/manager/test/fixtures/api/generated/phase6/`. The app's
 * `test/contract_phase6_test.dart` checks every key of its hand-written
 * fixtures is in these answers, with the same JSON type, and parses them.
 */
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const NOW = new Date("2026-10-21T08:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const Z1 = "6a6a6a6a-1111-4111-8111-000000000001";
const S1 = "6a6a6a6a-2222-4222-8222-000000000001"; // the shop
const R = "6a6a6a6a-3333-4333-8333-000000000001"; // a rider
const M = "6a6a6a6a-4444-4444-8444-000000000001"; // the viewing manager
const M2 = "6a6a6a6a-4444-4444-8444-000000000002"; // the manager who put a settlement up
const id = (n: number) => `6a6a6a6a-9999-4999-8999-${String(n).padStart(12, "0")}`;
const O1 = id(1), O2 = id(2), SET1 = id(10), SET2 = id(11), REQ1 = id(20), RF1 = id(30), PAY1 = id(40), COR1 = id(50), PO1 = id(60);

const order = (oid: string, code: string, total: number, extra: Row = {}): Row => ({
  id: oid, short_code: code, total, created_at: ago(60 * 26), status: "delivered", payment_method: "online",
  payment_status: "paid", zone_id: Z1, restaurant_id: S1, ...extra,
});

const tables: Record<string, Row[]> = {
  platform_settings: [{ vendor_commission_pct: 15, commission_gst_pct: 18 }],
  delivery_zones: [{ id: Z1, name: "Bemetara" }],
  restaurants: [{ id: S1, name: "Spice Hub", zone_id: Z1, settlement_cycle: "weekly" }],
  profiles: [
    { id: M, full_name: "Asha Verma", phone: null, role: "manager" },
    { id: M2, full_name: "Vikram Sahu", phone: null, role: "manager" },
    { id: R, full_name: "Ravi Kumar", phone: "+919800000007", role: "driver" },
  ],
  rider_profiles: [{ driver_id: R, rider_code: "DR-0007" }],
  orders: [order(O1, "D7K2", 420), order(O2, "Q8M1", 610, { created_at: ago(60 * 2) })],
  vendor_settlements: [
    {
      id: SET1, restaurant_id: S1, period_start: "2026-10-12", period_end: "2026-10-18", food_gross: 14200, commission: 2130,
      commission_gst: 383, other_charges: 0, refunds_recovered: 180, net_payable: 11507, status: "draft", kind: "batch",
      payment_ref: null, paid_at: null, paid_by: null, created_at: ago(60 * 5), created_by: M2, restaurants: { zone_id: Z1 },
    },
    {
      id: SET2, restaurant_id: S1, period_start: "2026-10-05", period_end: "2026-10-11", food_gross: 12000, commission: 1800,
      commission_gst: 324, other_charges: 0, refunds_recovered: 0, net_payable: 9876, status: "paid", kind: "batch",
      payment_ref: "UTR123456", paid_at: ago(60 * 24 * 6), paid_by: M, created_at: ago(60 * 24 * 7), created_by: M2, restaurants: { zone_id: Z1 },
    },
  ],
  vendor_settlement_orders: [
    {
      id: id(70), settlement_id: SET1, order_id: O1, food_gross: 380, commission: 57, commission_gst: 10, other_charges: 0, refund_recovered: 0,
      vendor_net: 313, contribution: 313, order_total: 420, delivery_fee: 30, payment_method: "online",
      orders: { short_code: "D7K2", created_at: ago(60 * 26), total: 420 }, vendor_settlements: { status: "draft" },
    },
  ],
  settlement_corrections: [
    {
      id: COR1, amount: 180, reason: "Refund after payout", status: "outstanding", original_settlement_id: SET2, applied_settlement_id: null,
      created_at: ago(60 * 30), refund_id: RF1, orders: { short_code: "Q8M1" }, restaurants: { zone_id: Z1 },
    },
  ],
  payment_requests: [
    {
      id: REQ1, kind: "vendor_settlement", subject_id: S1, zone_id: Z1, amount: 11507, period_end: "2026-10-18", salary_amount: null,
      method: "bank", note: "Weekly payout", status: "pending_approval", requested_by: M2, requested_at: ago(60 * 5),
      decided_by: null, decided_at: null, decision_note: null, reference: null, paid_on: null, result_id: null,
      self_approved: false, settlement_id: SET1,
    },
  ],
  payments: [
    {
      id: PAY1, status: "failed", created_at: ago(60 * 3), amount_paise: 61000, provider_payment_id: "pay_ABC", error_description: "Card declined",
      orders: { id: O2, short_code: "Q8M1", status: "placed", zone_id: Z1 },
    },
  ],
  refunds: [
    {
      id: RF1, order_id: O2, amount: 180, reason: "Item missing", origin: "customer", status: "pending", created_at: ago(60 * 4),
      decided_by: null, decided_at: null, provider_refund_id: null,
      orders: { id: O2, short_code: "Q8M1", total: 610, payment_method: "online", created_at: ago(60 * 2), restaurant_id: S1, zone_id: Z1 },
    },
  ],
};

const day = (d: string, n: number): Row => ({
  date: d, orders: n, customerPaid: n * 400, grossSales: n * 360, discountVendor: 20, discountPlatform: 10, refunds: 0,
  deliveryFees: n * 30, commission: n * 54, commissionGst: Math.round(n * 9.7), otherCharges: 0, cancelledCount: 1, cancelledValue: 300,
});
const rollup = {
  summary: {
    orders: 6, delivered: 5, grossSales: 2160, customerPaid: 2400, discountVendor: 40, discountPlatform: 20, refundsTotal: 180,
    refundsCount: 1, refundsOnCancelled: 0, cancelledCount: 2, cancelledValue: 600, deliveryFees: 180, commission: 324,
    commissionGst: 58, otherCharges: 0, foodGross: 2100, vendorNet: 1718,
  },
  byDay: [day("2026-10-19", 2), day("2026-10-20", 2), day("2026-10-21", 2)],
  byVendor: [
    {
      restaurantId: S1, orders: 6, delivered: 5, cancelled: 2, customerPaid: 2400, grossSales: 2160, discounts: 60, refunds: 180,
      foodGross: 2100, commission: 324, commissionGst: 58, otherCharges: 0, vendorNet: 1718,
    },
  ],
};

const rpcs: Record<string, unknown> = {
  ops_finance_rollup: rollup,
  ops_vendor_dues_scoped: [
    { restaurantId: S1, net: 11507, orders: 31, oldestDeliveredAt: ago(60 * 24 * 12), lastPaidAt: ago(60 * 24 * 6), outstandingCorrections: 1 },
  ],
  ops_rider_dues: [{ riderId: R, unpaid: 12000, oldestUnpaidOn: "2026-09-01", lastPayout: { amount: 11800, paidOn: "2026-09-30", reference: "UPI-77" } }],
  ops_rider_ledger_totals: { earnedInRange: 6000, unpaid: 12000 },
  ops_settlement_totals: { netPayable: 9876, count: 1 },
  ops_rider_payouts_scoped: {
    totals: { amount: 11800, count: 1 },
    items: [{ id: PO1, riderId: R, periodEnd: "2026-09-30", amount: 11800, method: "upi", reference: "UPI-77", paidOn: "2026-09-30", createdAt: ago(60 * 24 * 21), requestId: id(21), items: 1 }],
  },
  ops_reconciliation_orders: {
    summary: { matched: 1, mismatched: 0, correction_outstanding: 0, in_draft: 1, settlement_overdue: 0, recent: 0 },
    items: [
      { orderId: O1, orderCode: "D7K2", restaurantId: S1, deliveredAt: ago(60 * 25), state: "in_draft", expected: 313, settled: 313, difference: 0, settlementId: SET1, correctionId: null },
    ],
  },
  ops_reconciliation_online: {
    summary: { matched: 0, online_mismatch: 1, missing_payment: 1 },
    items: [
      { orderId: O1, orderCode: "D7K2", orderTotal: 420, paidAmount: 410, paymentId: "pay_77", state: "online_mismatch", at: ago(60 * 26) },
      { orderId: O2, orderCode: "Q8M1", orderTotal: 610, paidAmount: null, paymentId: null, state: "missing_payment", at: ago(60 * 2) },
    ],
  },
  ops_report_settlements: {
    rows: [{ id: SET1, restaurantId: S1, vendor: "Annapurna", kind: "batch", status: "draft", pendingApproval: true, periodStart: ago(60 * 24 * 8),
      periodEnd: ago(60 * 24 * 1), orders: 3, foodGross: 1200, commission: 180, refundsRecovered: 0, netPayable: 9876, paymentRef: null, paidAt: null, paidBy: null }],
    totalRows: 1,
    totals: { netPayable: 9876, count: 1, foodGross: 1200, commission: 180, refundsRecovered: 0 },
    byStatus: { pending_approval: { count: 1, netPayable: 9876 }, draft: { count: 1, netPayable: 9876 } },
  },
  ops_cash_reconciliation: {
    riders: [{ day: "2026-10-20", riderId: R, codOrders: 4, collected: 1900, deposited: 1700, disputed: false, depositIds: [id(80)] }],
    managers: [{ day: "2026-10-20", managerId: M, received: 1700, handedOn: 1700 }],
  },
};

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset", "or", "and", "not"].includes(key) || key.includes(".")) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const arg = raw.slice(dot + 1);
    const value = row[key];
    const list = () => arg.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
    if (op === "eq" && String(value) !== arg) return false;
    if (op === "neq" && String(value) === arg) return false;
    if (op === "in" && !list().includes(String(value))) return false;
    if (op === "is" && arg === "null" && value != null) return false;
    if (op === "gte" && (value == null || String(value) < arg)) return false;
    if (op === "lt" && (value == null || String(value) >= arg)) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  req.on("data", () => {});
  req.on("end", () => {
    const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(req.method === "HEAD" ? "" : JSON.stringify(obj));
    };
    const path = url.pathname.replace("/rest/v1/", "");
    if (path.startsWith("rpc/")) return send(200, rpcs[path.slice(4)] ?? []);
    const rows = (tables[path] ?? []).filter((r) => matches(r, url));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 1000;
    const page = rows.slice(offset, offset + limit);
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    if (single) return page.length ? send(200, page[0]) : send(406, { code: "PGRST116", message: "no rows" });
    send(200, page, { "content-range": `${offset}-${offset + page.length - 1}/${rows.length}` });
  });
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x".repeat(40);
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "y".repeat(40);

  const fin = await import("../../src/lib/data-access/manager-finance");
  const { listPaymentRequests } = await import("../../src/lib/data-access/payment-requests");
  const { runReport } = await import("../../src/lib/reports/registry");
  const { permittedKinds } = await import("../../src/lib/reports/definitions");

  const scope = { all: false as const, zoneIds: [Z1] };
  const range = { from: "2026-10-19", to: "2026-10-21" };
  const full: Record<string, boolean> = {
    "manager.finance.view": true, "manager.finance.adjust": true, "manager.finance.initiate_payment": true,
    "manager.finance.approve_payment": true, "manager.reports.view": true, "manager.cash": true,
  };
  const viewer = { id: M, perms: full, isAdmin: false };
  const notStale = async () => ({ stale: false, freshNet: 11507 });
  const kindsOf = (perms: Record<string, boolean>) => ({
    kinds: permittedKinds(perms, false).map((d) => ({ kind: d.kind, label: d.label, blurb: d.blurb, filters: d.filters, statusOptions: d.statusOptions })),
  });
  const report = (kind: "sales" | "orders", canSeeFinance = true) =>
    runReport({
      kind, scope, range, zoneId: null, vendorId: null, riderId: null, status: null, payment: "all", canSeeFinance,
      page: 1, pageSize: 50, all: false, generatedBy: { id: M, name: "Asha Verma" }, now: NOW,
    });
  const detail = await fin.getSettlementFor(scope, SET1, notStale);

  const files: Record<string, unknown> = {
    finance_overview: await fin.getFinanceOverview(scope, { range, zone: null }, NOW),
    vendor_dues: await fin.listVendorDues(scope, { zone: null, delayedOnly: false, cursor: null }, NOW),
    rider_dues: await fin.listRiderDues(scope, { zone: null, delayedOnly: false, cursor: null }, NOW),
    rider_payouts: await fin.listRiderPayouts(scope, { range, zone: null, riderId: null, cursor: null }),
    finance_issues: await (async () => {
      const r = await fin.listFinanceIssues(scope, { range, zone: null, type: null, cursor: null }, NOW);
      return { items: r.items, nextCursor: r.nextCursor, counts: r.counts };
    })(),
    settlements_list: await fin.listSettlementsFor(scope, { status: null, vendorId: null, range: null, zone: null, cursor: null }),
    settlement_detail: detail && {
      settlement: detail.settlement, lines: detail.lines, corrections: detail.corrections,
      request: detail.requestId ? await listPaymentRequests(scope, viewer, { status: null, kind: null, zone: null, mine: false, cursor: null }).then((p) => p.items.find((i) => i.id === detail.requestId) ?? null) : null,
      checks: detail.checks,
    },
    refunds: await fin.listRefundsFor(scope, { status: null, range: null, zone: null, cursor: null }),
    reconciliation_orders: await fin.getReconciliation(scope, { section: "orders", range, zone: null, state: null, cursor: null }, NOW),
    reconciliation_online: await fin.getReconciliation(scope, { section: "online", range, zone: null, state: null, cursor: null }, NOW),
    reconciliation_cash: await fin.getReconciliation(scope, { section: "cash", range, zone: null, state: null, cursor: null }, NOW),
    payment_requests_settlement: await listPaymentRequests(scope, viewer, { status: null, kind: "vendor_settlement", zone: null, mine: false, cursor: null }),
    report_kinds: kindsOf(full),
    report_kinds_no_finance: kindsOf({ ...full, "manager.finance.view": false }),
    report_sales: await report("sales"),
    report_sales_no_finance: await report("sales", false),
    report_vendor_settlement: await report("vendor-settlement"),
  };

  // Keep the route's own key order for the settlement detail (checks is a route field too).
  const sd = files.settlement_detail as Record<string, unknown> | null;
  if (sd && !("checks" in sd)) delete sd.checks;

  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  for (const [name, body] of Object.entries(files)) if (body === null || body === undefined) fail(`${name}: the reader returned nothing for seeded rows`);
  const sales = files.report_sales as { highlights?: { key: string }[]; columns?: { key: string }[]; generatedAt?: string } | null;
  if (!sales?.generatedAt) fail("a report carries generatedAt");
  const noFin = files.report_sales_no_finance as { columns?: { key: string }[] } | null;
  const finKeys = ["commission", "commissionGst", "platformCommission", "vendorNet", "deliveryFees"];
  if (noFin?.columns?.some((c) => finKeys.includes(c.key))) fail("a report without manager.finance.view carries no finance columns");
  const kindsNoFin = (files.report_kinds_no_finance as { kinds: { kind: string }[] }).kinds.map((k) => k.kind);
  if (kindsNoFin.includes("commission") || kindsNoFin.includes("vendor-settlement")) fail("finance report kinds are not offered without manager.finance.view");
  const req = (files.payment_requests_settlement as { items: Record<string, unknown>[] }).items[0];
  if (!req || !("settlementId" in req) || !("selfApproved" in req)) fail("a vendor settlement request carries settlementId and selfApproved");
  const blob = JSON.stringify(files);
  if (/[ऀ-ॿ]/.test(blob) || blob.includes("labelHi")) fail("no Hindi in any Phase 6 answer");

  const out = join(process.cwd(), "apps/manager/test/fixtures/api/generated/phase6");
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + "\n");
  server.close();

  if (failures.length) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`\nphase 6 contract: ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`phase 6 contract: wrote ${Object.keys(files).length} answers to ${out}`);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
