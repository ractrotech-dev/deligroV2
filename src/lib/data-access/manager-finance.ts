import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { getCommissionGstPct, getVendorCommissionDefault } from "@/lib/data-access/admin-commission";
import { loadPeople, loadZoneNames } from "@/lib/data-access/manager-riders";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { addDays, istDayStart, istDayKey, type DateRange } from "@/lib/metrics";
import {
  dailyFromFinanceRollup,
  salesFromRollup,
  type CashManagerDay,
  type CashRiderDay,
  type FinanceRollup,
  type ReconciliationRollupItem,
  type RiderDueRollupRow,
  type VendorDueRollupRow,
} from "@/lib/ops/finance-rollup";
import {
  FINANCE_ISSUE_TYPES,
  FINANCE_THRESHOLDS,
  RECONCILIATION_STATES,
  ageHours,
  cashDayStatus,
  isSettlementDelayed,
  issueSeverity,
  stuckPaymentCounts,
  vendorDueNet,
  type FinanceIssueType,
  type OnlinePaymentState,
  type ReconciliationState,
  type SettlementCycle,
} from "@/lib/ops/finance-rules";
import {
  ISSUE_TITLES,
  SETTLEMENT_HEADER_COLUMNS,
  encodeKeyCursor,
  sortIssues,
  toSettlementSummary,
  type FinanceFilters,
  type FinanceIssue,
  type FinanceNames,
  type FinanceOverview,
  type ReconciliationPayload,
  type RefundItem,
  type RiderDue,
  type SettlementCorrection,
  type SettlementHeaderRow,
  type SettlementLine,
  type SettlementSummary,
  type VendorDue,
} from "@/lib/ops/finance-contract";

/**
 * Manager Finance (§7): the reads behind the Finance tab. Every figure comes
 * from migration 0157's rollups (SQL mirrors of src/lib/metrics) or from the
 * settlement tables directly; nothing here recomputes money inline. Every read
 * is scoped: zone-filtered in SQL, or joined through the restaurant's or
 * order's zone. Callers authorise first (managerApiContext + finance.view).
 */

const PAGE = 50;
/** Each issue source is read up to this many rows; the list says so when it is cut. */
const ISSUE_SOURCE_CAP = 200;

type Zones = readonly string[] | null;

function zonesOf(scope: ManagerScope, zone: string | null): Zones {
  return scopeZoneIds(zone ? narrowScope(scope, zone) : scope);
}
const zoneArg = (z: Zones) => (z === null ? null : [...z]);
const isEmpty = (z: Zones) => z !== null && z.length === 0;

async function pricingDefaults(): Promise<{ commissionDefault: number; gstPct: number }> {
  const [commissionDefault, gstPct] = await Promise.all([getVendorCommissionDefault(), getCommissionGstPct()]);
  return { commissionDefault, gstPct };
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createAdminClient().rpc(fn, args);
  if (error) throw error;
  return data as T;
}

function bounds(range: DateRange): { start: string; end: string } {
  return { start: istDayStart(range.from).toISOString(), end: istDayStart(addDays(range.to, 1)).toISOString() };
}

// ── names ────────────────────────────────────────────────────────────────

interface ShopRow { id: string; name: string | null; zone_id: string | null; settlement_cycle: string | null }

async function loadShops(ids: readonly string[]): Promise<Map<string, ShopRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, ShopRow>();
  if (unique.length === 0) return out;
  const { data, error } = await readInChunks<ShopRow>(unique, (chunk) =>
    createAdminClient().from("restaurants").select("id, name, zone_id, settlement_cycle").in("id", chunk) as unknown as PromiseLike<{ data: ShopRow[] | null; error: unknown }>
  );
  if (error) throw error;
  for (const s of data) out.set(s.id, s);
  return out;
}

async function financeNames(shopIds: readonly string[], personIds: readonly (string | null | undefined)[]): Promise<FinanceNames & { shops: Map<string, ShopRow> }> {
  const shops = await loadShops(shopIds);
  const [people, zones] = await Promise.all([
    loadPeople(personIds),
    loadZoneNames([...shops.values()].map((s) => s.zone_id)),
  ]);
  return {
    shops,
    shop: (id) => ({ id, name: shops.get(id)?.name?.trim() || "Shop" }),
    zoneOfShop: (id) => {
      const z = shops.get(id)?.zone_id;
      return z ? { id: z, name: zones.get(z) ?? "Zone" } : null;
    },
    person: (id) => (id ? { id, name: people.get(id)?.name ?? "Staff" } : null),
  };
}

async function filtersOf(range: DateRange, zone: string | null): Promise<FinanceFilters> {
  if (!zone) return { from: range.from, to: range.to, zone: null };
  const names = await loadZoneNames([zone]);
  return { from: range.from, to: range.to, zone: { id: zone, name: names.get(zone) ?? "Zone" } };
}

const cycleOf = (s: ShopRow | undefined): SettlementCycle => (s?.settlement_cycle === "monthly" ? "monthly" : "weekly");

// ── vendor dues ──────────────────────────────────────────────────────────

async function vendorDueRows(zones: Zones): Promise<VendorDueRollupRow[]> {
  if (isEmpty(zones)) return [];
  const { commissionDefault, gstPct } = await pricingDefaults();
  const rows = await rpc<VendorDueRollupRow[]>("ops_vendor_dues_scoped", {
    p_zone_ids: zoneArg(zones), p_commission_default: commissionDefault, p_gst_pct: gstPct,
  });
  return (rows ?? []).map((r) => ({
    ...r, net: Number(r.net), orders: Number(r.orders), outstandingCorrections: Number(r.outstandingCorrections ?? 0),
  }));
}

async function pendingRequests(kind: "vendor_settlement" | "rider_payout", subjectIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (subjectIds.length === 0) return out;
  const { data, error } = await readInChunks<{ id: string; subject_id: string }>(subjectIds, (chunk) =>
    createAdminClient().from("payment_requests").select("id, subject_id").eq("kind", kind).eq("status", "pending_approval").in("subject_id", chunk) as unknown as PromiseLike<{ data: { id: string; subject_id: string }[] | null; error: unknown }>
  );
  if (error) throw error;
  for (const r of data) out.set(r.subject_id, r.id);
  return out;
}

export async function listVendorDues(
  scope: ManagerScope,
  q: { zone: string | null; delayedOnly: boolean; cursor: { at: string; id: string } | null },
  now: Date
): Promise<{ items: VendorDue[]; nextCursor: string | null; totals: { payable: number; count: number } }> {
  const zones = zonesOf(scope, q.zone);
  const rows = await vendorDueRows(zones);
  const ids = rows.map((r) => r.restaurantId);
  const [names, pending] = await Promise.all([financeNames(ids, []), pendingRequests("vendor_settlement", ids)]);
  let items: VendorDue[] = rows.map((r) => {
    const shop = names.shops.get(r.restaurantId);
    const cycle = cycleOf(shop);
    return {
      vendor: names.shop(r.restaurantId),
      zone: names.zoneOfShop(r.restaurantId),
      cycle,
      unsettledOrders: r.orders,
      oldestUnsettledAt: r.oldestDeliveredAt,
      // Outstanding corrections come off, as the next settlement takes them.
      ...vendorDueNet(r.net, r.outstandingCorrections),
      outstandingCorrections: r.outstandingCorrections,
      lastPaidAt: r.lastPaidAt,
      delayed: isSettlementDelayed(cycle, r.oldestDeliveredAt ? new Date(r.oldestDeliveredAt) : null, now),
      pendingRequestId: pending.get(r.restaurantId) ?? null,
    };
  });
  if (q.delayedOnly) items = items.filter((i) => i.delayed);
  // Largest payable first; the cursor is (payable, vendor id).
  items.sort((a, b) => (b.payable - a.payable) || (a.vendor.id < b.vendor.id ? -1 : 1));
  const totals = { payable: items.reduce((s, i) => s + i.payable, 0), count: items.length };
  return { ...pageOf(items, q.cursor, (i) => [String(i.payable).padStart(12, "0"), i.vendor.id], true), totals };
}

/** Page an already-sorted list by a (key, id) cursor; `desc` when the key sorts descending. */
function pageOf<T>(items: T[], cursor: { at: string; id: string } | null, key: (t: T) => [string, string], desc: boolean): { items: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    const idx = items.findIndex((t) => {
      const [k, id] = key(t);
      return k === cursor.at && id === cursor.id;
    });
    start = idx >= 0 ? idx + 1 : items.length;
  }
  void desc;
  const page = items.slice(start, start + PAGE);
  const last = page[page.length - 1];
  const more = start + PAGE < items.length;
  return { items: page, nextCursor: more && last ? encodeKeyCursor(...key(last)) : null };
}

// ── rider dues and payouts ───────────────────────────────────────────────

export async function listRiderDues(
  scope: ManagerScope,
  q: { zone: string | null; delayedOnly: boolean; cursor: { at: string; id: string } | null },
  now: Date
): Promise<{ items: RiderDue[]; nextCursor: string | null; totals: { payable: number; count: number } }> {
  const zones = zonesOf(scope, q.zone);
  if (isEmpty(zones)) return { items: [], nextCursor: null, totals: { payable: 0, count: 0 } };
  const rows = await rpc<RiderDueRollupRow[]>("ops_rider_dues", { p_zone_ids: zoneArg(zones), p_rider: null });
  const ids = (rows ?? []).map((r) => r.riderId);
  const [people, pending] = await Promise.all([loadPeople(ids), pendingRequests("rider_payout", ids)]);
  const today = istDayKey(now);
  let items: RiderDue[] = (rows ?? []).map((r) => ({
    rider: { id: r.riderId, name: people.get(r.riderId)?.name ?? "Rider", code: people.get(r.riderId)?.code ?? null },
    unpaid: Number(r.unpaid),
    oldestUnpaidOn: r.oldestUnpaidOn,
    lastPayout: r.lastPayout ? { amount: Number(r.lastPayout.amount), paidOn: r.lastPayout.paidOn, reference: r.lastPayout.reference } : null,
    delayed: !!r.oldestUnpaidOn && r.oldestUnpaidOn < addDays(today, -FINANCE_THRESHOLDS.riderPayoutDelayDays),
    pendingRequestId: pending.get(r.riderId) ?? null,
  }));
  if (q.delayedOnly) items = items.filter((i) => i.delayed);
  items.sort((a, b) => (b.unpaid - a.unpaid) || (a.rider.id < b.rider.id ? -1 : 1));
  const totals = { payable: Math.round(items.reduce((s, i) => s + i.unpaid * 100, 0)) / 100, count: items.length };
  return { ...pageOf(items, q.cursor, (i) => [i.unpaid.toFixed(2).padStart(14, "0"), i.rider.id], true), totals };
}

export interface PayoutWithRider {
  id: string;
  amount: number;
  method: "bank" | "upi" | "cash" | "other";
  reference: string | null;
  paidOn: string;
  periodEnd: string;
  items: number;
  requestId: string | null;
  rider: { id: string; name: string; code: string | null };
}

export async function listRiderPayouts(
  scope: ManagerScope,
  q: { range: DateRange; zone: string | null; riderId: string | null; cursor: { at: string; id: string } | null }
): Promise<{ items: PayoutWithRider[]; nextCursor: string | null; totals: { amount: number; count: number } }> {
  const zones = zonesOf(scope, q.zone);
  if (isEmpty(zones)) return { items: [], nextCursor: null, totals: { amount: 0, count: 0 } };
  // Cursor: "paidOn|createdAt" and the payout id.
  const [beforeOn, beforeAt] = q.cursor ? q.cursor.at.split("|") : [null, null];
  const res = await rpc<{ totals: { amount: number; count: number }; items: { id: string; riderId: string; periodEnd: string; amount: number; method: string; reference: string | null; paidOn: string; createdAt: string; requestId: string | null; items: number }[] }>(
    "ops_rider_payouts_scoped",
    { p_zone_ids: zoneArg(zones), p_from: q.range.from, p_to: q.range.to, p_rider: q.riderId, p_before_on: beforeOn, p_before_at: beforeAt, p_before_id: q.cursor?.id ?? null, p_limit: PAGE }
  );
  const rows = res.items ?? [];
  const people = await loadPeople(rows.map((r) => r.riderId));
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      method: r.method as PayoutWithRider["method"],
      reference: r.reference,
      paidOn: r.paidOn,
      periodEnd: r.periodEnd,
      items: Number(r.items ?? 0),
      requestId: r.requestId,
      rider: { id: r.riderId, name: people.get(r.riderId)?.name ?? "Rider", code: people.get(r.riderId)?.code ?? null },
    })),
    nextCursor: rows.length > PAGE && last ? encodeKeyCursor(`${last.paidOn}|${last.createdAt}`, last.id) : null,
    totals: { amount: Number(res.totals?.amount ?? 0), count: Number(res.totals?.count ?? 0) },
  };
}

// ── issues ───────────────────────────────────────────────────────────────

type Embedded<T> = T | T[] | null;
const first = <T,>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function listFinanceIssues(
  scope: ManagerScope,
  q: { range: DateRange; zone: string | null; type: FinanceIssueType | null; cursor: { at: string; id: string } | null },
  now: Date
): Promise<{ items: FinanceIssue[]; nextCursor: string | null; counts: Record<FinanceIssueType, number>; truncated: boolean }> {
  const zones = zonesOf(scope, q.zone);
  const counts = Object.fromEntries(FINANCE_ISSUE_TYPES.map((t) => [t, 0])) as Record<FinanceIssueType, number>;
  if (isEmpty(zones)) return { items: [], nextCursor: null, counts, truncated: false };
  const all = await collectIssues(zones, q.range, now);
  for (const i of all.items) counts[i.type] += 1;
  const filtered = sortIssues(q.type ? all.items.filter((i) => i.type === q.type) : all.items);
  const page = pageOf(filtered, q.cursor, (i) => [i.since, `${i.type}:${i.subject.id}`], true);
  return { ...page, counts, truncated: all.truncated };
}

async function collectIssues(zones: Zones, range: DateRange, now: Date): Promise<{ items: FinanceIssue[]; truncated: boolean }> {
  const supabase = createAdminClient();
  const z = zoneArg(zones);
  const { start, end } = bounds(range);
  const stuckBefore = new Date(now.getTime() - FINANCE_THRESHOLDS.stuckPaymentMinutes * 60_000).toISOString();
  const unsentBefore = new Date(now.getTime() - FINANCE_THRESHOLDS.refundUnsentHours * 3_600_000).toISOString();
  const staleBefore = new Date(now.getTime() - FINANCE_THRESHOLDS.draftStaleDays * 86_400_000).toISOString();
  const overdueBefore = new Date(now.getTime() - FINANCE_THRESHOLDS.approvalOverdueHours * 3_600_000).toISOString();

  type PayRow = { id: string; status: string; created_at: string; amount_paise: number; provider_payment_id: string | null; error_description: string | null; orders: Embedded<{ id: string; short_code: string | null; status: string; zone_id: string | null }> };
  const payments = (statuses: string[]) => {
    let query = supabase.from("payments")
      .select("id, status, created_at, amount_paise, provider_payment_id, error_description, orders!inner(id, short_code, status, zone_id)")
      .in("status", statuses).order("created_at", { ascending: false }).limit(ISSUE_SOURCE_CAP);
    if (z) query = query.in("orders.zone_id", z);
    return query;
  };
  const failedQ = payments(["failed"]).gte("created_at", start).lt("created_at", end);
  const stuckQ = payments(["pending", "authorized"]).lt("created_at", stuckBefore).neq("orders.status", "cancelled");

  type RefundRow = { id: string; amount: number; created_at: string; decided_at: string | null; orders: Embedded<{ id: string; short_code: string | null; payment_method: string | null; zone_id: string | null }> };
  let unsentQ = supabase.from("refunds")
    .select("id, amount, created_at, decided_at, orders!inner(id, short_code, payment_method, zone_id)")
    .eq("status", "approved").is("provider_refund_id", null).eq("orders.payment_method", "online")
    .lt("created_at", unsentBefore).order("created_at", { ascending: false }).limit(ISSUE_SOURCE_CAP);
  if (z) unsentQ = unsentQ.in("orders.zone_id", z);

  type DraftRow = { id: string; created_at: string; net_payable: number; restaurant_id: string; restaurants: Embedded<{ zone_id: string | null; name: string | null }> };
  let draftQ = supabase.from("vendor_settlements")
    .select("id, created_at, net_payable, restaurant_id, restaurants!inner(zone_id, name)")
    .eq("status", "draft").lt("created_at", staleBefore).order("created_at", { ascending: false }).limit(ISSUE_SOURCE_CAP);
  if (z) draftQ = draftQ.in("restaurants.zone_id", z);

  type ReqRow = { id: string; kind: string; amount: number; requested_at: string; subject_id: string };
  let overdueQ = supabase.from("payment_requests").select("id, kind, amount, requested_at, subject_id")
    .eq("status", "pending_approval").lt("requested_at", overdueBefore).order("requested_at", { ascending: false }).limit(ISSUE_SOURCE_CAP);
  if (z) overdueQ = overdueQ.in("zone_id", z);

  const [failed, stuck, unsent, drafts, overdue, dues, riderDues] = await Promise.all([
    failedQ, stuckQ, unsentQ, draftQ, overdueQ, vendorDueRows(zones),
    rpc<RiderDueRollupRow[]>("ops_rider_dues", { p_zone_ids: z, p_rider: null }),
  ]);
  for (const r of [failed, stuck, unsent, drafts, overdue]) if (r.error) throw r.error;

  const items: FinanceIssue[] = [];
  const issue = (type: FinanceIssueType, since: string, rest: Omit<FinanceIssue, "type" | "severity" | "title" | "since"> & { title?: string }): FinanceIssue => ({
    type, severity: issueSeverity(type, ageHours(new Date(since), now)), title: rest.title ?? ISSUE_TITLES[type], since,
    detail: rest.detail, amount: rest.amount, subject: rest.subject, reference: rest.reference,
  });
  for (const p of (failed.data ?? []) as unknown as PayRow[]) {
    const o = first(p.orders);
    items.push(issue("failed_payment", p.created_at, { detail: p.error_description, amount: Math.round(Number(p.amount_paise) / 100),
      subject: { kind: "order", id: o?.id ?? p.id, label: o?.short_code ?? "Order" }, reference: p.provider_payment_id }));
  }
  for (const p of (stuck.data ?? []) as unknown as PayRow[]) {
    const o = first(p.orders);
    // An abandoned checkout (pending payment, order still placed) is not a transaction.
    if (!stuckPaymentCounts(p.status, o?.status ?? "")) continue;
    items.push(issue("stuck_payment", p.created_at, { detail: `Payment ${p.status} since ${new Date(p.created_at).toISOString()}`, amount: Math.round(Number(p.amount_paise) / 100),
      subject: { kind: "order", id: o?.id ?? p.id, label: o?.short_code ?? "Order" }, reference: p.provider_payment_id }));
  }
  for (const r of (unsent.data ?? []) as unknown as RefundRow[]) {
    const o = first(r.orders);
    items.push(issue("refund_unsent", r.decided_at ?? r.created_at, { detail: "Approved, but no gateway refund is recorded", amount: Number(r.amount),
      subject: { kind: "refund", id: r.id, label: o?.short_code ?? "Refund" }, reference: null }));
  }
  for (const d of (drafts.data ?? []) as unknown as DraftRow[]) {
    items.push(issue("draft_stale", d.created_at, { detail: first(d.restaurants)?.name ?? null, amount: Number(d.net_payable),
      subject: { kind: "settlement", id: d.id, label: first(d.restaurants)?.name ?? "Settlement" }, reference: null }));
  }
  for (const r of (overdue.data ?? []) as ReqRow[]) {
    items.push(issue("approval_overdue", r.requested_at, { detail: r.kind === "vendor_settlement" ? "Vendor settlement" : "Rider payout", amount: Number(r.amount),
      subject: { kind: "payment_request", id: r.id, label: r.kind === "vendor_settlement" ? "Vendor settlement" : "Rider payout" }, reference: null }));
  }
  const shops = await loadShops(dues.map((d) => d.restaurantId));
  for (const d of dues) {
    const cycle = cycleOf(shops.get(d.restaurantId));
    if (d.net <= 0 || !d.oldestDeliveredAt || !isSettlementDelayed(cycle, new Date(d.oldestDeliveredAt), now)) continue;
    items.push(issue("settlement_delayed", d.oldestDeliveredAt, { detail: `${d.orders} unsettled order${d.orders === 1 ? "" : "s"}, ${cycle} cycle`, amount: d.net,
      subject: { kind: "vendor", id: d.restaurantId, label: shops.get(d.restaurantId)?.name?.trim() || "Shop" }, reference: null }));
  }
  const today = istDayKey(now);
  const delayedRiders = (riderDues ?? []).filter((r) => r.oldestUnpaidOn && r.oldestUnpaidOn < addDays(today, -FINANCE_THRESHOLDS.riderPayoutDelayDays));
  const people = await loadPeople(delayedRiders.map((r) => r.riderId));
  for (const r of delayedRiders) {
    items.push(issue("rider_payout_delayed", istDayStart(r.oldestUnpaidOn!).toISOString(), { detail: `Unpaid since ${r.oldestUnpaidOn}`, amount: Number(r.unpaid),
      subject: { kind: "rider", id: r.riderId, label: people.get(r.riderId)?.name ?? "Rider" }, reference: null }));
  }
  const truncated = [failed, stuck, unsent, drafts, overdue].some((r) => (r.data?.length ?? 0) >= ISSUE_SOURCE_CAP);
  return { items, truncated };
}

// ── overview ─────────────────────────────────────────────────────────────

export async function getFinanceOverview(scope: ManagerScope, q: { range: DateRange; zone: string | null }, now: Date): Promise<FinanceOverview> {
  const zones = zonesOf(scope, q.zone);
  const filters = await filtersOf(q.range, q.zone);
  const { start, end } = bounds(q.range);
  const empty = isEmpty(zones);
  const { commissionDefault, gstPct } = await pricingDefaults();
  const supabase = createAdminClient();

  const [rollup, dues, ledger, vendorPaid, riderPaid, issues, pendingApprovals, corrections] = await Promise.all([
    empty ? null : rpc<FinanceRollup>("ops_finance_rollup", {
      p_zone_ids: zoneArg(zones), p_start: start, p_end: end, p_restaurant: null, p_payment: null,
      p_commission_default: commissionDefault, p_gst_pct: gstPct,
    }),
    vendorDueRows(zones),
    empty ? null : rpc<{ earnedInRange: number; unpaid: number }>("ops_rider_ledger_totals", { p_zone_ids: zoneArg(zones), p_from: q.range.from, p_to: q.range.to }),
    empty ? null : rpc<{ netPayable: number; count: number }>("ops_settlement_totals", { p_zone_ids: zoneArg(zones), p_status: "paid", p_restaurant: null, p_start: start, p_end: end }),
    empty ? null : rpc<{ totals: { amount: number; count: number } }>("ops_rider_payouts_scoped", {
      p_zone_ids: zoneArg(zones), p_from: q.range.from, p_to: q.range.to, p_rider: null, p_before_on: null, p_before_at: null, p_before_id: null, p_limit: 1,
    }),
    empty ? { items: [] as FinanceIssue[], truncated: false } : collectIssues(zones, q.range, now),
    (async () => {
      if (empty) return 0;
      let c = supabase.from("payment_requests").select("id", { count: "exact", head: true }).eq("status", "pending_approval");
      if (zones) c = c.in("zone_id", [...zones]);
      const { count, error } = await c;
      if (error) throw error;
      return count ?? 0;
    })(),
    correctionTotals(zones, start, end),
  ]);

  const sales = rollup ? salesFromRollup(rollup.summary) : salesFromRollup({} as FinanceRollup["summary"]);
  const vendorPayable = dues.reduce((s, d) => s + vendorDueNet(d.net, d.outstandingCorrections).payable, 0);
  const vendorRecoverable = dues.reduce((s, d) => s + vendorDueNet(d.net, d.outstandingCorrections).recoverable, 0);
  const riderPayable = Number(ledger?.unpaid ?? 0);
  return {
    filters,
    generatedAt: now.toISOString(),
    sales: {
      grossSales: sales.grossSales,
      customerPaid: sales.customerPaid,
      netSales: sales.netSales,
      discounts: sales.discounts,
      // onCancelled: approved refunds on orders that were then cancelled. They
      // are in the refunds report but not here — cancelled orders are not
      // sales, so their refunds never come off net sales (counted once).
      refunds: { total: sales.refunds.total, count: sales.refunds.count, onCancelled: sales.refunds.onCancelled },
      adjustments: corrections,
      platformCommission: sales.platformCommission,
      deliveryFees: sales.deliveryFees,
      riderEarnings: Number(ledger?.earnedInRange ?? 0),
      vendorPayable,
      vendorRecoverable,
      riderPayable,
      cancelled: sales.cancelled,
    },
    payments: {
      vendorDue: vendorPayable,
      vendorPaid: { amount: Number(vendorPaid?.netPayable ?? 0), count: Number(vendorPaid?.count ?? 0) },
      riderDue: riderPayable,
      riderPaid: { amount: Number(riderPaid?.totals?.amount ?? 0), count: Number(riderPaid?.totals?.count ?? 0) },
      issues: {
        warning: issues.items.filter((i) => i.severity === "warning").length,
        critical: issues.items.filter((i) => i.severity === "critical").length,
      },
      pendingApprovals,
    },
    series: rollup
      ? dailyFromFinanceRollup(rollup, q.range).map((d) => ({
          date: d.date, customerPaid: d.customerPaid, netSales: d.netSales, commission: d.commission + d.commissionGst + d.otherCharges,
          deliveryFees: d.deliveryFees, refunds: d.refunds,
        }))
      : [],
  };
}

/** Outstanding corrections as of now; applied ones by when they were applied (in range). */
async function correctionTotals(zones: Zones, start: string, end: string): Promise<FinanceOverview["sales"]["adjustments"]> {
  const zero = { correctionsOutstanding: { count: 0, amount: 0 }, correctionsApplied: { count: 0, amount: 0 } };
  if (isEmpty(zones)) return zero;
  const supabase = createAdminClient();
  type Row = { id: string; amount: number; status: string; restaurants: Embedded<{ zone_id: string | null }> };
  const read = (status: string, applied: boolean) =>
    readAllRows<Row>((from, to) => {
      let query = supabase.from("settlement_corrections").select("id, amount, status, restaurants!inner(zone_id)").eq("status", status);
      if (applied) query = query.gte("applied_at", start).lt("applied_at", end);
      if (zones) query = query.in("restaurants.zone_id", [...zones]);
      return query.order("id").range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>;
    });
  const [out, app] = await Promise.all([read("outstanding", false), read("applied", true)]);
  if (out.error) throw out.error;
  if (app.error) throw app.error;
  const sum = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.amount), 0);
  return {
    correctionsOutstanding: { count: out.data.length, amount: sum(out.data) },
    correctionsApplied: { count: app.data.length, amount: sum(app.data) },
  };
}

// ── settlements ──────────────────────────────────────────────────────────

export type SettlementStatusFilter = "draft" | "paid" | "void" | "pending_approval";

type SettlementRequestRef = NonNullable<SettlementSummary["request"]>;

async function requestsForSettlements(ids: readonly string[]): Promise<Map<string, SettlementRequestRef>> {
  const out = new Map<string, SettlementRequestRef>();
  if (ids.length === 0) return out;
  type Row = { id: string; status: string; settlement_id: string; requested_at: string };
  const { data, error } = await readInChunks<Row>(ids, (chunk) =>
    createAdminClient().from("payment_requests").select("id, status, settlement_id, requested_at").in("settlement_id", chunk) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>
  );
  if (error) throw error;
  // The newest request per settlement wins.
  const sorted = [...data].sort((a, b) => (a.requested_at < b.requested_at ? -1 : 1));
  for (const r of sorted) out.set(r.settlement_id, { id: r.id, status: r.status as SettlementRequestRef["status"] });
  return out;
}

async function lineCounts(ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(ids.map(async (id) => {
    const { count, error } = await createAdminClient().from("vendor_settlement_orders").select("id", { count: "exact", head: true }).eq("settlement_id", id);
    if (error) throw error;
    out.set(id, count ?? 0);
  }));
  return out;
}

async function serializeSettlements(rows: SettlementHeaderRow[]): Promise<SettlementSummary[]> {
  const ids = rows.map((r) => r.id);
  const [names, requests, counts] = await Promise.all([
    financeNames(rows.map((r) => r.restaurant_id), rows.flatMap((r) => [r.paid_by, r.created_by])),
    requestsForSettlements(ids),
    lineCounts(ids),
  ]);
  return rows.map((r) => toSettlementSummary(r, names, counts.get(r.id) ?? 0, requests.get(r.id) ?? null));
}

export async function listSettlementsFor(
  scope: ManagerScope,
  q: { status: SettlementStatusFilter | null; vendorId: string | null; range: DateRange | null; zone: string | null; cursor: { at: string; id: string } | null }
): Promise<{ items: SettlementSummary[]; nextCursor: string | null; totals: { netPayable: number; count: number } }> {
  const zones = zonesOf(scope, q.zone);
  if (isEmpty(zones)) return { items: [], nextCursor: null, totals: { netPayable: 0, count: 0 } };
  const supabase = createAdminClient();
  const timeCol = q.status === "paid" ? "paid_at" : "created_at";
  const b = q.range ? bounds(q.range) : null;

  let ids: string[] | null = null;
  if (q.status === "pending_approval") {
    let r = supabase.from("payment_requests").select("settlement_id").eq("kind", "vendor_settlement").eq("status", "pending_approval").not("settlement_id", "is", null);
    if (zones) r = r.in("zone_id", [...zones]);
    const { data, error } = await r;
    if (error) throw error;
    ids = (data ?? []).map((x) => x.settlement_id as string);
    if (ids.length === 0) return { items: [], nextCursor: null, totals: { netPayable: 0, count: 0 } };
  }

  let query = supabase.from("vendor_settlements").select(`${SETTLEMENT_HEADER_COLUMNS}, restaurants!inner(zone_id)`);
  if (zones) query = query.in("restaurants.zone_id", [...zones]);
  if (q.status && q.status !== "pending_approval") query = query.eq("status", q.status);
  if (q.status === "pending_approval") query = query.eq("status", "draft").in("id", ids!);
  if (q.vendorId) query = query.eq("restaurant_id", q.vendorId);
  if (b) query = query.gte(timeCol, b.start).lt(timeCol, b.end);
  if (q.cursor) query = query.or(`${timeCol}.lt.${q.cursor.at},and(${timeCol}.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  query = query.order(timeCol, { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(PAGE + 1);

  const [{ data, error }, totals] = await Promise.all([
    query,
    rpc<{ netPayable: number; count: number }>("ops_settlement_totals", {
      p_zone_ids: zoneArg(zones), p_status: q.status, p_restaurant: q.vendorId, p_start: b?.start ?? null, p_end: b?.end ?? null,
    }),
  ]);
  if (error) throw error;
  const rows = (data ?? []) as unknown as SettlementHeaderRow[];
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  const lastAt = last ? (timeCol === "paid_at" ? last.paid_at : last.created_at) : null;
  return {
    items: await serializeSettlements(page),
    nextCursor: rows.length > PAGE && last && lastAt ? encodeKeyCursor(lastAt, last.id) : null,
    totals: { netPayable: Number(totals?.netPayable ?? 0), count: Number(totals?.count ?? 0) },
  };
}

/** The header in scope, or null (out of scope answers 404 — never "forbidden", which would confirm it exists). */
export async function settlementHeaderFor(scope: ManagerScope, id: string): Promise<SettlementHeaderRow | null> {
  const zones = scopeZoneIds(scope);
  if (zones !== null && zones.length === 0) return null;
  let query = createAdminClient().from("vendor_settlements").select(`${SETTLEMENT_HEADER_COLUMNS}, restaurants!inner(zone_id)`).eq("id", id);
  if (zones) query = query.in("restaurants.zone_id", [...zones]);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as unknown as SettlementHeaderRow) ?? null;
}

/** One settlement's summary in scope, or null. */
export async function settlementSummaryFor(scope: ManagerScope, id: string): Promise<SettlementSummary | null> {
  const header = await settlementHeaderFor(scope, id);
  return header ? (await serializeSettlements([header]))[0] : null;
}

/** Is this shop in scope? (initiate checks it before building a draft) */
export async function shopInScope(scope: ManagerScope, restaurantId: string): Promise<boolean> {
  const zones = scopeZoneIds(scope);
  if (zones !== null && zones.length === 0) return false;
  let query = createAdminClient().from("restaurants").select("id").eq("id", restaurantId);
  if (zones) query = query.in("zone_id", [...zones]);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function getSettlementFor(
  scope: ManagerScope,
  id: string,
  isDraftStale: (settlementId: string) => Promise<{ stale: boolean; freshNet: number }>
): Promise<{ settlement: SettlementSummary; lines: SettlementLine[]; corrections: SettlementCorrection[]; requestId: string | null; checks: { stale: boolean; freshNetPayable: number } } | null> {
  const header = await settlementHeaderFor(scope, id);
  if (!header) return null;
  const supabase = createAdminClient();
  type LineRow = { order_id: string; food_gross: number; commission: number; commission_gst: number | null; other_charges: number | null; refund_recovered: number; vendor_net: number; contribution: number; order_total: number | null; delivery_fee: number | null; payment_method: string | null; orders: Embedded<{ short_code: string | null; created_at: string; total: number }> };
  type CorrRow = { id: string; amount: number; reason: string | null; status: string; original_settlement_id: string; applied_settlement_id: string | null; created_at: string; orders: Embedded<{ short_code: string | null }> };
  const [lines, corrections, settlement] = await Promise.all([
    readAllRows<LineRow>((from, to) =>
      supabase.from("vendor_settlement_orders")
        .select("order_id, food_gross, commission, commission_gst, other_charges, refund_recovered, vendor_net, contribution, order_total, delivery_fee, payment_method, orders(short_code, created_at, total)")
        .eq("settlement_id", id).order("order_id").range(from, to) as unknown as PromiseLike<{ data: LineRow[] | null; error: unknown }>),
    supabase.from("settlement_corrections")
      .select("id, amount, reason, status, original_settlement_id, applied_settlement_id, created_at, orders(short_code)")
      .or(`original_settlement_id.eq.${id},applied_settlement_id.eq.${id}`).order("created_at"),
    serializeSettlements([header]),
  ]);
  if (lines.error) throw lines.error;
  if (corrections.error) throw corrections.error;
  const checks = header.status === "draft" ? await isDraftStale(id) : { stale: false, freshNet: Number(header.net_payable ?? 0) };
  return {
    settlement: settlement[0],
    lines: lines.data.map((l) => {
      const o = first(l.orders);
      return {
        orderId: l.order_id,
        orderCode: o?.short_code ?? l.order_id.slice(0, 8).toUpperCase(),
        placedAt: o?.created_at ?? "",
        paymentMethod: l.payment_method === "online" || l.payment_method === "cod" ? l.payment_method : null,
        orderTotal: Number(l.order_total ?? o?.total ?? 0),
        deliveryFee: Number(l.delivery_fee ?? 0),
        foodGross: Number(l.food_gross),
        commission: Number(l.commission),
        commissionGst: Number(l.commission_gst ?? 0),
        otherCharges: Number(l.other_charges ?? 0),
        refundRecovered: Number(l.refund_recovered),
        vendorNet: Number(l.vendor_net),
        contribution: Number(l.contribution),
      };
    }),
    corrections: ((corrections.data ?? []) as unknown as CorrRow[]).map((c) => ({
      id: c.id,
      orderCode: first(c.orders)?.short_code ?? "",
      amount: Number(c.amount),
      reason: c.reason,
      status: c.status as SettlementCorrection["status"],
      originalSettlementId: c.original_settlement_id,
      appliedSettlementId: c.applied_settlement_id,
      createdAt: c.created_at,
    })),
    requestId: settlement[0].request?.id ?? null,
    checks: { stale: checks.stale, freshNetPayable: checks.freshNet },
  };
}

// ── refunds ──────────────────────────────────────────────────────────────

type RefundRowFull = {
  id: string; order_id: string; amount: number; reason: string | null; origin: string | null; status: string; created_at: string;
  decided_by: string | null; provider_refund_id: string | null;
  orders: Embedded<{ id: string; short_code: string | null; total: number; payment_method: string | null; created_at: string; restaurant_id: string; zone_id: string | null }>;
};
const REFUND_SELECT = "id, order_id, amount, reason, origin, status, created_at, decided_by, provider_refund_id, orders!inner(id, short_code, total, payment_method, created_at, restaurant_id, zone_id)";

async function settlementEffects(rows: RefundRowFull[]): Promise<Map<string, RefundItem["settlementEffect"]>> {
  const out = new Map<string, RefundItem["settlementEffect"]>();
  const approved = rows.filter((r) => r.status === "approved");
  if (approved.length === 0) {
    for (const r of rows) out.set(r.id, "none");
    return out;
  }
  const supabase = createAdminClient();
  const [corr, lines] = await Promise.all([
    supabase.from("settlement_corrections").select("refund_id").in("refund_id", approved.map((r) => r.id)),
    supabase.from("vendor_settlement_orders").select("order_id, vendor_settlements!inner(status)").in("order_id", approved.map((r) => r.order_id)),
  ]);
  if (corr.error) throw corr.error;
  if (lines.error) throw lines.error;
  const withCorrection = new Set((corr.data ?? []).map((c) => c.refund_id as string));
  const inDraft = new Set(((lines.data ?? []) as unknown as { order_id: string; vendor_settlements: Embedded<{ status: string }> }[])
    .filter((l) => first(l.vendor_settlements)?.status === "draft").map((l) => l.order_id));
  for (const r of rows) {
    if (r.status !== "approved") out.set(r.id, "none");
    else if (withCorrection.has(r.id)) out.set(r.id, "correction_created");
    else if (inDraft.has(r.order_id)) out.set(r.id, "draft_flagged");
    else out.set(r.id, "none");
  }
  return out;
}

async function serializeRefunds(rows: RefundRowFull[]): Promise<RefundItem[]> {
  const [names, effects] = await Promise.all([
    financeNames(rows.map((r) => first(r.orders)?.restaurant_id ?? "").filter(Boolean), rows.map((r) => r.decided_by)),
    settlementEffects(rows),
  ]);
  return rows.map((r) => {
    const o = first(r.orders);
    const origin = (["customer", "vendor_rejected", "admin", "manager", "system"] as const).find((x) => x === r.origin) ?? "customer";
    return {
      id: r.id,
      order: {
        id: o?.id ?? r.order_id,
        code: o?.short_code ?? r.order_id.slice(0, 8).toUpperCase(),
        total: Number(o?.total ?? 0),
        paymentMethod: o?.payment_method === "online" || o?.payment_method === "cod" ? o.payment_method : null,
        placedAt: o?.created_at ?? "",
      },
      vendor: names.shop(o?.restaurant_id ?? ""),
      amount: Number(r.amount),
      reason: r.reason,
      origin,
      status: r.status as RefundItem["status"],
      requestedAt: r.created_at,
      decidedBy: names.person(r.decided_by),
      providerRefundId: r.provider_refund_id,
      settlementEffect: effects.get(r.id) ?? null,
    };
  });
}

export async function listRefundsFor(
  scope: ManagerScope,
  q: { status: "pending" | "approved" | "denied" | null; range: DateRange | null; zone: string | null; cursor: { at: string; id: string } | null }
): Promise<{ items: RefundItem[]; nextCursor: string | null; counts: { pending: number } }> {
  const zones = zonesOf(scope, q.zone);
  if (isEmpty(zones)) return { items: [], nextCursor: null, counts: { pending: 0 } };
  const supabase = createAdminClient();
  const oldestFirst = q.status === "pending";
  let query = supabase.from("refunds").select(REFUND_SELECT);
  if (zones) query = query.in("orders.zone_id", [...zones]);
  if (q.status) query = query.eq("status", q.status);
  if (q.range) {
    const b = bounds(q.range);
    query = query.gte("created_at", b.start).lt("created_at", b.end);
  }
  if (q.cursor) {
    const op = oldestFirst ? "gt" : "lt";
    query = query.or(`created_at.${op}.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.${op}.${q.cursor.id})`);
  }
  query = query.order("created_at", { ascending: oldestFirst }).order("id", { ascending: oldestFirst }).limit(PAGE + 1);
  let pendingCount = supabase.from("refunds").select("id, orders!inner(zone_id)", { count: "exact", head: true }).eq("status", "pending");
  if (zones) pendingCount = pendingCount.in("orders.zone_id", [...zones]);
  const [{ data, error }, pending] = await Promise.all([query, pendingCount]);
  if (error) throw error;
  if (pending.error) throw pending.error;
  const rows = (data ?? []) as unknown as RefundRowFull[];
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    items: await serializeRefunds(page),
    nextCursor: rows.length > PAGE && last ? encodeKeyCursor(last.created_at, last.id) : null,
    counts: { pending: pending.count ?? 0 },
  };
}

/** One refund in scope (through its order's zone), or null. */
export async function getRefundFor(scope: ManagerScope, id: string): Promise<RefundItem | null> {
  const zones = scopeZoneIds(scope);
  if (zones !== null && zones.length === 0) return null;
  let query = createAdminClient().from("refunds").select(REFUND_SELECT).eq("id", id);
  if (zones) query = query.in("orders.zone_id", [...zones]);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await serializeRefunds([data as unknown as RefundRowFull]))[0];
}

// ── reconciliation ───────────────────────────────────────────────────────

export async function getReconciliation(
  scope: ManagerScope,
  q: { section: "orders" | "online" | "cash"; range: DateRange; zone: string | null; state: string | null; cursor: { at: string; id: string } | null },
  now: Date
): Promise<ReconciliationPayload> {
  const zones = zonesOf(scope, q.zone);
  const filters = await filtersOf(q.range, q.zone);
  const { start, end } = bounds(q.range);

  if (q.section === "orders") {
    const summary = Object.fromEntries(RECONCILIATION_STATES.map((s) => [s, 0])) as Record<ReconciliationState, number>;
    if (isEmpty(zones)) return { section: "orders", filters, summary, items: [], nextCursor: null };
    const { commissionDefault, gstPct } = await pricingDefaults();
    const res = await rpc<{ summary: Record<string, number>; items: ReconciliationRollupItem[] }>("ops_reconciliation_orders", {
      p_zone_ids: zoneArg(zones), p_start: start, p_end: end, p_commission_default: commissionDefault, p_gst_pct: gstPct,
      p_now: now.toISOString(), p_state: q.state, p_after_at: q.cursor?.at ?? null, p_after_id: q.cursor?.id ?? null, p_limit: PAGE,
    });
    for (const [k, v] of Object.entries(res.summary ?? {})) if (k in summary) summary[k as ReconciliationState] = Number(v);
    const rows = res.items ?? [];
    const page = rows.slice(0, PAGE);
    const names = await financeNames(page.map((r) => r.restaurantId), []);
    const last = page[page.length - 1];
    return {
      section: "orders",
      filters,
      summary,
      items: page.map((r) => ({
        orderId: r.orderId,
        orderCode: r.orderCode ?? r.orderId.slice(0, 8).toUpperCase(),
        vendor: names.shop(r.restaurantId),
        deliveredAt: r.deliveredAt,
        state: r.state as ReconciliationState,
        expected: Number(r.expected),
        settled: r.settled === null ? null : Number(r.settled),
        difference: Number(r.difference),
        settlementId: r.settlementId,
        correctionId: r.correctionId,
      })),
      nextCursor: rows.length > PAGE && last ? encodeKeyCursor(last.deliveredAt, last.orderId) : null,
    };
  }

  if (q.section === "online") {
    const summary = { matched: 0, online_mismatch: 0, missing_payment: 0 };
    if (isEmpty(zones)) return { section: "online", filters, summary, items: [], nextCursor: null };
    // Every online, paid-or-refunded order in range against its captured
    // payment, classified and paged in SQL (0157, classifyOnlinePayment's
    // rule) — the summary counts every order, never a capped sample.
    type OnlineItem = { orderId: string; orderCode: string; orderTotal: number; paidAmount: number | null; paymentId: string | null; state: OnlinePaymentState; at: string };
    const res = await rpc<{ summary: Record<string, number>; items: OnlineItem[] }>("ops_reconciliation_online", {
      p_zone_ids: zoneArg(zones), p_start: start, p_end: end, p_state: q.state,
      p_after_at: q.cursor?.at ?? null, p_after_id: q.cursor?.id ?? null, p_limit: PAGE,
    });
    for (const k of Object.keys(summary) as (keyof typeof summary)[]) summary[k] = Number(res.summary?.[k] ?? 0);
    const rows = res.items ?? [];
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return {
      section: "online",
      filters,
      summary,
      items: page.map((i) => ({ orderId: i.orderId, orderCode: i.orderCode, orderTotal: Number(i.orderTotal),
        paidAmount: i.paidAmount === null ? null : Number(i.paidAmount), paymentId: i.paymentId, state: i.state })),
      nextCursor: rows.length > PAGE && last ? encodeKeyCursor(last.at, last.orderId) : null,
    };
  }

  // cash
  const cashSummary = { collected: 0, deposited: 0, pending: 0, disputedDays: 0 };
  if (isEmpty(zones)) return { section: "cash", filters, summary: cashSummary, items: [], managers: [], nextCursor: null };
  const res = await rpc<{ riders: CashRiderDay[]; managers: CashManagerDay[] }>("ops_cash_reconciliation", {
    p_zone_ids: zoneArg(zones), p_from: q.range.from, p_to: q.range.to, p_rider: null,
  });
  const people = await loadPeople([...(res.riders ?? []).map((r) => r.riderId), ...(res.managers ?? []).map((m) => m.managerId)]);
  let items = (res.riders ?? []).map((r) => {
    const collected = Number(r.collected);
    const deposited = Number(r.deposited);
    return {
      day: r.day,
      rider: { id: r.riderId, name: people.get(r.riderId)?.name ?? "Rider", code: people.get(r.riderId)?.code ?? null },
      collected,
      deposited,
      pending: Math.max(0, collected - deposited),
      status: cashDayStatus(collected, deposited, !!r.disputed),
      depositIds: r.depositIds ?? [],
    };
  });
  for (const i of items) {
    cashSummary.collected += i.collected;
    cashSummary.deposited += i.deposited;
    cashSummary.pending += i.pending;
    if (i.status === "disputed") cashSummary.disputedDays += 1;
  }
  if (q.state) items = items.filter((i) => i.status === q.state);
  const page = pageOf(items, q.cursor, (i) => [i.day, i.rider.id], true);
  return {
    section: "cash",
    filters,
    summary: cashSummary,
    items: page.items,
    managers: (res.managers ?? []).map((m) => ({
      manager: { id: m.managerId, name: people.get(m.managerId)?.name ?? "Manager" },
      day: m.day,
      received: Number(m.received),
      handedOn: Number(m.handedOn),
      pending: Math.max(0, Number(m.received) - Number(m.handedOn)),
    })),
    nextCursor: page.nextCursor,
  };
}
