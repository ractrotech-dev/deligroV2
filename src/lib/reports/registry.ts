import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { getCommissionGstPct, getVendorCommissionDefault } from "@/lib/data-access/admin-commission";
import { loadPeople, loadZoneNames } from "@/lib/data-access/manager-riders";
import { loadShopNames } from "@/lib/data-access/ops-metrics";
import { readAllRows } from "@/lib/data-access/read-all";
import { addDays, istDayKey, istDayStart, type DateRange } from "@/lib/metrics";
import type { FinanceRollup, CashRiderDay } from "@/lib/ops/finance-rollup";
import {
  buildAverageOrder, buildCancellation, buildCashReconciliation, buildCommission, buildFinanceDaily, buildMarketing,
  buildOrders, buildRefundsAdjustments, buildRiderPerformance, buildSales, buildSupportTickets, buildVendorPerformance,
  type MarketingRollup, type OrderReportRow, type RefundReportRow, type RiderPerfRow, type TicketReportRow, type VendorOpsRow,
} from "@/lib/reports/builders";
import { reportMeta, visibleColumns, type ReportKindId } from "@/lib/reports/definitions";
import { MAX_EXPORT_ROWS, MAX_PAGE_SIZE, num, sumKeys, type Built, type ReportPayload, type ReportRow } from "@/lib/reports/payload";

/**
 * The report registry's runner (§13): one entry point for the manager API and
 * the admin Reports page. It fetches through the scoped SQL rollups (0157,
 * 0158) — never unbounded rows into Node — builds the rows with the pure
 * builders, drops finance columns the viewer may not see, pages, and refuses
 * an export over 10 000 rows (`too_large`, with the count).
 *
 * The caller authorises first (managerApiContext + the kind's permission, or
 * requireRole admin with scope { all: true }).
 */

export interface RunReportInput {
  kind: ReportKindId;
  scope: ManagerScope;
  range: DateRange;
  zoneId: string | null;
  vendorId: string | null;
  riderId: string | null;
  status: string | null;
  payment: "all" | "cod" | "online";
  canSeeFinance: boolean;
  page: number;
  pageSize: number;
  all: boolean;
  generatedBy: { id: string; name: string };
  now?: Date;
}

type Zones = readonly string[] | null;

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createAdminClient().rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function runReport(input: RunReportInput): Promise<ReportPayload | { error: "too_large"; rows: number }> {
  const def = reportMeta(input.kind);
  const now = input.now ?? new Date();
  const scope = input.zoneId ? narrowScope(input.scope, input.zoneId) : input.scope;
  const zones = scopeZoneIds(scope);
  const empty = zones !== null && zones.length === 0;
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, input.pageSize));
  const page = Math.max(1, input.page);
  const offset = input.all ? 0 : (page - 1) * pageSize;
  const limit = input.all ? MAX_EXPORT_ROWS + 1 : pageSize;

  const built: Built = empty
    ? { rows: [], totalRows: 0, totals: null, highlights: [], notes: [], paged: true }
    : await build(input, zones, offset, limit);

  if (input.all && built.totalRows > MAX_EXPORT_ROWS) return { error: "too_large", rows: built.totalRows };

  const cols = visibleColumns(def, input.canSeeFinance);
  const keys = new Set(cols.map((c) => c.key));
  const pick = (row: ReportRow | null): ReportRow | null => {
    if (!row) return null;
    const out: ReportRow = {};
    for (const k of keys) out[k] = row[k] ?? null;
    return out;
  };
  const allRows = built.paged ? built.rows : (input.all ? built.rows : built.rows.slice(offset, offset + pageSize));
  const financeHighlightKeys = new Set(def.columns.filter((c) => c.finance).map((c) => c.key));
  financeHighlightKeys.add("cancelled"); // a money figure in sales' highlights

  const filters = await describeFilters(input, scope);
  return {
    kind: def.kind,
    title: def.label,
    subtitle: def.blurb,
    generatedAt: now.toISOString(),
    generatedBy: input.generatedBy,
    filters,
    highlights: input.canSeeFinance || def.permission !== "reports"
      ? built.highlights
      : built.highlights.filter((h) => !financeHighlightKeys.has(h.key)),
    columns: cols.map((c) => ({ key: c.key, label: c.label, type: c.type })),
    rows: allRows.map((r) => pick(r)!),
    totals: built.totals ? pick(built.totals) : (built.rows.length === 0 ? zeroTotals(cols) : null),
    page: input.all ? 1 : page,
    pageSize: input.all ? allRows.length : pageSize,
    totalRows: built.totalRows,
    notes: built.notes,
  };
}

/** An empty report still has a totals row of zeros (never NaN). */
function zeroTotals(cols: { key: string; type: string }[]): ReportRow {
  const out: ReportRow = {};
  for (const c of cols) out[c.key] = c.type === "int" || c.type === "money" || c.type === "money2" ? 0 : null;
  return out;
}

async function describeFilters(input: RunReportInput, scope: ManagerScope): Promise<ReportPayload["filters"]> {
  void scope;
  const [zones, shops, people] = await Promise.all([
    input.zoneId ? loadZoneNames([input.zoneId]) : Promise.resolve(new Map<string, string>()),
    input.vendorId ? loadShopNames([input.vendorId]).then((s) => s.names) : Promise.resolve(new Map<string, string>()),
    input.riderId ? loadPeople([input.riderId]) : Promise.resolve(new Map<string, { name: string; code: string | null; phone: string | null }>()),
  ]);
  return {
    from: input.range.from,
    to: input.range.to,
    zone: input.zoneId ? { id: input.zoneId, name: zones.get(input.zoneId) ?? "Zone" } : null,
    vendor: input.vendorId ? { id: input.vendorId, name: shops.get(input.vendorId) ?? "Shop" } : null,
    rider: input.riderId ? { id: input.riderId, name: people.get(input.riderId)?.name ?? "Rider" } : null,
    status: input.status,
    payment: input.payment,
  };
}

async function financeRollup(zones: Zones, range: DateRange, vendorId: string | null, payment: string | null): Promise<FinanceRollup> {
  const [commissionDefault, gstPct] = await Promise.all([getVendorCommissionDefault(), getCommissionGstPct()]);
  return rpc<FinanceRollup>("ops_finance_rollup", {
    p_zone_ids: zones === null ? null : [...zones],
    p_start: istDayStart(range.from).toISOString(),
    p_end: istDayStart(addDays(range.to, 1)).toISOString(),
    p_restaurant: vendorId,
    p_payment: payment,
    p_commission_default: commissionDefault,
    p_gst_pct: gstPct,
  });
}

async function build(input: RunReportInput, zones: Zones, offset: number, limit: number): Promise<Built> {
  const z = zones === null ? null : [...zones];
  const start = istDayStart(input.range.from).toISOString();
  const end = istDayStart(addDays(input.range.to, 1)).toISOString();
  const payment = input.payment === "all" ? null : input.payment;

  switch (input.kind) {
    case "sales":
      return buildSales(await financeRollup(zones, input.range, input.vendorId, payment), input.range);
    case "average-order":
      return buildAverageOrder(await financeRollup(zones, input.range, input.vendorId, payment), input.range);
    case "finance-daily": {
      const [rollup, vendorPaid, riderPaid] = await Promise.all([
        financeRollup(zones, input.range, input.vendorId, null),
        vendorPaidByDay(zones, input.vendorId, start, end),
        input.vendorId ? Promise.resolve(new Map<string, number>()) : riderPaidByDay(zones, input.range),
      ]);
      return buildFinanceDaily(rollup, input.range, { vendor: vendorPaid, rider: riderPaid });
    }
    case "commission": {
      const rollup = await financeRollup(zones, input.range, input.vendorId, null);
      const names = (await loadShopNames(rollup.byVendor.map((v) => v.restaurantId))).names;
      return buildCommission(rollup, (id) => names.get(id) ?? "Shop");
    }
    case "vendor-performance": {
      const [ops, rollup] = await Promise.all([
        rpc<VendorOpsRow[]>("ops_report_vendor_ops", { p_zone_ids: z, p_start: start, p_end: end, p_restaurant: input.vendorId }),
        financeRollup(zones, input.range, input.vendorId, null),
      ]);
      const zoneNames = await loadZoneNames((ops ?? []).map((o) => o.zoneId));
      return buildVendorPerformance(ops ?? [], rollup, (id) => (id ? zoneNames.get(id) ?? "Zone" : "—"));
    }
    case "rider-performance":
      return buildRiderPerformance(await rpc<RiderPerfRow[]>("ops_report_rider_performance", { p_zone_ids: z, p_start: start, p_end: end, p_rider: input.riderId }) ?? []);
    case "orders":
    case "cancellation": {
      const cancellation = input.kind === "cancellation";
      const res = await rpc<{ totalRows: number; totals: Record<string, unknown>; rows: OrderReportRow[] }>("ops_report_orders", {
        p_zone_ids: z, p_start: start, p_end: end, p_restaurant: input.vendorId, p_rider: cancellation ? null : input.riderId,
        p_status: cancellation ? null : input.status, p_payment: payment, p_cancelled_only: cancellation,
        p_cancelled_by: cancellation ? input.status : null, p_offset: offset, p_limit: limit,
      });
      return cancellation ? buildCancellation(res) : buildOrders(res);
    }
    case "refunds-adjustments":
      return buildRefundsAdjustments(await rpc<{ totalRows: number; totals: Record<string, unknown>; rows: RefundReportRow[] }>("ops_report_refunds_adjustments", {
        p_zone_ids: z, p_start: start, p_end: end, p_restaurant: input.vendorId, p_status: input.status, p_offset: offset, p_limit: limit,
      }));
    case "support-tickets":
      return buildSupportTickets(await rpc<{ totalRows: number; totals: Record<string, unknown>; rows: TicketReportRow[] }>("ops_report_support_tickets", {
        p_zone_ids: z, p_start: start, p_end: end, p_status: input.status, p_offset: offset, p_limit: limit,
      }));
    case "marketing": {
      const zoneNames = z ? [...(await loadZoneNamesAndSlugs(z))] : null;
      return buildMarketing(await rpc<MarketingRollup>("ops_report_marketing", {
        p_zone_ids: z, p_zone_names: zoneNames, p_start: start, p_end: end, p_restaurant: input.vendorId,
      }));
    }
    case "cash-reconciliation": {
      const res = await rpc<{ riders: CashRiderDay[] }>("ops_cash_reconciliation", {
        p_zone_ids: z, p_from: input.range.from, p_to: input.range.to, p_rider: input.riderId,
      });
      const people = await loadPeople((res.riders ?? []).map((r) => r.riderId));
      return buildCashReconciliation(res.riders ?? [], (id) => ({ name: people.get(id)?.name ?? "Rider", code: people.get(id)?.code ?? null }));
    }
    case "vendor-settlement":
      return vendorSettlementReport(zones, input, start, end, offset, limit);
    case "rider-payout":
      return riderPayoutReport(zones, input);
  }
}

/** Lower-cased names and slugs of the zones, for banners' free-text `target_zones`. */
async function loadZoneNamesAndSlugs(ids: string[]): Promise<Set<string>> {
  const { data, error } = await createAdminClient().from("delivery_zones").select("name, slug").in("id", ids);
  if (error) throw error;
  const out = new Set<string>();
  for (const z of (data ?? []) as { name: string | null; slug: string | null }[]) {
    if (z.name) out.add(z.name.trim().toLowerCase());
    if (z.slug) out.add(z.slug.trim().toLowerCase());
  }
  return out;
}

async function vendorPaidByDay(zones: Zones, vendorId: string | null, start: string, end: string): Promise<Map<string, number>> {
  type Row = { id: string; paid_at: string; net_payable: number };
  const res = await readAllRows<Row>((from, to) => {
    let q = createAdminClient().from("vendor_settlements").select("id, paid_at, net_payable, restaurants!inner(zone_id)")
      .eq("status", "paid").gte("paid_at", start).lt("paid_at", end);
    if (zones) q = q.in("restaurants.zone_id", [...zones]);
    if (vendorId) q = q.eq("restaurant_id", vendorId);
    return q.order("paid_at").order("id").range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>;
  });
  if (res.error) throw res.error;
  const out = new Map<string, number>();
  for (const r of res.data) out.set(istDayKey(r.paid_at), (out.get(istDayKey(r.paid_at)) ?? 0) + num(r.net_payable));
  return out;
}

interface PayoutItem { id: string; riderId: string; periodEnd: string; amount: number; method: string; reference: string | null; paidOn: string; createdAt: string; requestId: string | null }

/** Every payout in range (keyset pages of 200; riders × periods is small). */
async function payoutsInRange(zones: Zones, range: DateRange, riderId: string | null): Promise<{ items: PayoutItem[]; totals: { amount: number; count: number } }> {
  const items: PayoutItem[] = [];
  let before: { on: string; at: string; id: string } | null = null;
  let totals = { amount: 0, count: 0 };
  for (let i = 0; i < 60; i++) {
    const res: { totals: { amount: number; count: number }; items: PayoutItem[] } = await rpc("ops_rider_payouts_scoped", {
      p_zone_ids: zones === null ? null : [...zones], p_from: range.from, p_to: range.to, p_rider: riderId,
      p_before_on: before?.on ?? null, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null, p_limit: 200,
    });
    totals = { amount: num(res.totals?.amount), count: num(res.totals?.count) };
    const page = (res.items ?? []).slice(0, 200);
    items.push(...page);
    if ((res.items ?? []).length <= 200 || items.length > MAX_EXPORT_ROWS) break;
    const last = page[page.length - 1];
    before = { on: last.paidOn, at: last.createdAt, id: last.id };
  }
  return { items, totals };
}

async function riderPaidByDay(zones: Zones, range: DateRange): Promise<Map<string, number>> {
  const { items } = await payoutsInRange(zones, range, null);
  const out = new Map<string, number>();
  for (const p of items) out.set(p.paidOn, (out.get(p.paidOn) ?? 0) + num(p.amount));
  return out;
}

async function riderPayoutReport(zones: Zones, input: RunReportInput): Promise<Built> {
  const { items, totals } = await payoutsInRange(zones, input.range, input.riderId);
  const supabase = createAdminClient();
  const reqIds = items.map((p) => p.requestId).filter((x): x is string => !!x);
  const reqs = new Map<string, { requested_by: string; decided_by: string | null }>();
  if (reqIds.length) {
    const { data, error } = await supabase.from("payment_requests").select("id, requested_by, decided_by").in("id", reqIds.slice(0, 1000));
    if (error) throw error;
    for (const r of (data ?? []) as { id: string; requested_by: string; decided_by: string | null }[]) reqs.set(r.id, r);
  }
  const people = await loadPeople([...items.map((p) => p.riderId), ...[...reqs.values()].flatMap((r) => [r.requested_by, r.decided_by])]);
  const rows: ReportRow[] = items.map((p) => {
    const req = p.requestId ? reqs.get(p.requestId) : undefined;
    return {
      rider: people.get(p.riderId)?.name ?? "Rider", code: people.get(p.riderId)?.code ?? null, periodEnd: p.periodEnd, amount: num(p.amount),
      method: p.method, reference: p.reference, paidOn: p.paidOn,
      approvedBy: req?.decided_by ? people.get(req.decided_by)?.name ?? "Staff" : null,
      requestedBy: req ? people.get(req.requested_by)?.name ?? "Staff" : null,
    };
  });
  return {
    rows, totalRows: totals.count, paged: false, notes: ["Riders are salaried: these are recorded salary payouts, approved by a second person."],
    totals: { rider: "Total", amount: totals.amount },
    highlights: [{ key: "amount", label: "Paid to riders", value: totals.amount, type: "money2" }, { key: "count", label: "Payouts", value: totals.count, type: "int" }],
  };
}

async function vendorSettlementReport(zones: Zones, input: RunReportInput, start: string, end: string, offset: number, limit: number): Promise<Built> {
  const timeCol = input.status === "paid" ? "paid_at" : "created_at";
  let q = createAdminClient().from("vendor_settlements")
    .select("id, restaurant_id, kind, status, period_start, period_end, food_gross, commission, refunds_recovered, net_payable, payment_ref, paid_at, paid_by, created_at, restaurants!inner(zone_id, name), vendor_settlement_orders(count)", { count: "exact" })
    .gte(timeCol, start).lt(timeCol, end);
  if (zones) q = q.in("restaurants.zone_id", [...zones]);
  if (input.status) q = q.eq("status", input.status);
  if (input.vendorId) q = q.eq("restaurant_id", input.vendorId);
  const [{ data, error, count }, totals] = await Promise.all([
    q.order(timeCol, { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1),
    rpc<{ netPayable: number; count: number }>("ops_settlement_totals", {
      p_zone_ids: zones === null ? null : [...zones], p_status: input.status, p_restaurant: input.vendorId, p_start: start, p_end: end,
    }),
  ]);
  if (error) throw error;
  type Row = { restaurant_id: string; kind: string | null; status: string; period_start: string; period_end: string; food_gross: number; commission: number;
    refunds_recovered: number; net_payable: number; payment_ref: string | null; paid_at: string | null; paid_by: string | null;
    restaurants: { name: string | null } | { name: string | null }[] | null; vendor_settlement_orders: { count: number }[] | null };
  const rows = (data ?? []) as unknown as Row[];
  const people = await loadPeople(rows.map((r) => r.paid_by));
  const shopName = (r: Row) => (Array.isArray(r.restaurants) ? r.restaurants[0]?.name : r.restaurants?.name)?.trim() || "Shop";
  const out: ReportRow[] = rows.map((r) => ({
    vendor: shopName(r), kind: r.kind ?? "batch", status: r.status, periodStart: istDayKey(r.period_start), periodEnd: addDays(istDayKey(r.period_end), -1),
    orders: num(r.vendor_settlement_orders?.[0]?.count), foodGross: num(r.food_gross), commission: num(r.commission),
    refundsRecovered: num(r.refunds_recovered), netPayable: num(r.net_payable), paymentRef: r.payment_ref, paidAt: r.paid_at,
    paidBy: r.paid_by ? people.get(r.paid_by)?.name ?? "Staff" : null,
  }));
  const pageSums = sumKeys(out, ["orders", "foodGross", "commission", "refundsRecovered"]);
  return {
    rows: out, totalRows: count ?? out.length, paged: true, notes: [],
    totals: { vendor: "Total", netPayable: num(totals?.netPayable), ...(out.length === (count ?? 0) ? pageSums : {}) },
    highlights: [{ key: "netPayable", label: "Net payable", value: num(totals?.netPayable), type: "money" }, { key: "count", label: "Settlements", value: num(totals?.count), type: "int" }],
  };
}
