import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyZoneScope, narrowScope, scopeAllows, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { loadMetricOrders, loadPricing, loadRefunds } from "@/lib/data-access/ops-metrics";
import { getCommissionGstPct, getVendorCommissionDefault } from "@/lib/data-access/admin-commission";
import { signedDocumentUrl } from "@/lib/data-access/vendor-documents";
import { addDays, istDayKey, istDayStart } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics";
import { isCountedOrder, platformCommission, salesSummary } from "@/lib/metrics";
import { encodeCursor, decodeCursor } from "@/lib/ops/order-query";
import {
  OPEN_TICKET_STATUSES,
  TICKET_COLUMNS,
  buildVendorDetail,
  encodeNameCursor,
  openStateOf,
  toReviewItem,
  toTicketSummary,
  toVendorDocument,
  toVendorListItem,
  type DocumentRow,
  type OpenState,
  type ReviewItem,
  type ReviewRow,
  type TicketRow,
  type TicketSummary,
  type VendorCounts,
  type VendorDetail,
  type VendorDetailRow,
  type VendorFinance,
  type VendorListExtras,
  type VendorListItem,
  type VendorListRow,
  type VendorQuery,
} from "@/lib/ops/vendor-contract";
import { allowedVendorActions, ratingDistribution, vendorRates, type VendorStatus } from "@/lib/ops/vendor-rules";

/**
 * Manager vendors (§4.1, §4.3–§4.15): list, detail, reviews, documents and
 * complaints for the shops in a manager's zones. Every read is the service
 * role, so every `restaurants` read applies the scope here (the database's
 * manager policies, 0145, say the same for direct reads). Explicit columns
 * only — bank details, PAN, GST, UPI and credentials are never selected.
 * Callers authorise first (managerApiContext("manager.vendors.view")).
 */

const LIST_COLUMNS =
  "id, name, slug, status, category, zone_id, image_url, rating, rating_count, created_at, delivery_zones(name)";
const DETAIL_COLUMNS =
  `${LIST_COLUMNS}, status_reason, status_changed_by, status_changed_at, description, shop_phone, owner_name, owner_mobile, ` +
  "owner_email, address, landmark, pincode, lat, lng, opening_time, closing_time, weekly_off, closed_until, " +
  "delivery_available, self_pickup, prep_minutes, fssai_number, tc_accepted_at, tc_version, settlement_cycle";

type ZoneEmbed = { name: string | null } | { name: string | null }[] | null;
type RawListRow = Omit<VendorListRow, "zone_name"> & { delivery_zones: ZoneEmbed };
type RawDetailRow = RawListRow & Omit<VendorDetailRow, keyof VendorListRow> & {
  status_changed_by: string | null;
  settlement_cycle: string | null;
};

function flattenZone<T extends RawListRow>(r: T): T & { zone_name: string | null } {
  const z = Array.isArray(r.delivery_zones) ? r.delivery_zones[0] : r.delivery_zones;
  return { ...r, zone_name: z?.name ?? null };
}

/** A value for a PostgREST filter, quoted so commas, brackets and colons are literal. */
function pgQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Search text with PostgREST's filter syntax characters removed. */
function searchTerm(q: string): string {
  return q.replace(/[,()*%"\\:]/g, " ").replace(/\s+/g, " ").trim();
}

function todayBounds(now: Date): { day: string; start: string } {
  const day = istDayKey(now);
  return { day, start: istDayStart(day).toISOString() };
}

// ── per-shop extras ──────────────────────────────────────────────────────────

/** Open state for many shops: restaurant_status_now (0062). Unanswered = closed. */
async function openStates(ids: string[]): Promise<Map<string, OpenState>> {
  const out = new Map<string, OpenState>();
  if (ids.length === 0) return out;
  const supabase = createAdminClient();
  const { data, error } = await readInChunks<{ restaurant_id: string; status: string }>(ids, async (chunk) => {
    const res = await supabase.rpc("restaurant_open_statuses", { p_ids: chunk });
    return { data: (res.data ?? []) as { restaurant_id: string; status: string }[], error: res.error };
  });
  if (error) throw error;
  for (const r of data ?? []) out.set(r.restaurant_id, openStateOf(r.status));
  return out;
}

/** A builder narrowed to the filters this module chains. */
type Filters = {
  or(filter: string): Filters;
  eq(column: string, value: unknown): Filters;
  in(column: string, values: readonly unknown[]): Filters;
  order(column: string): Filters;
  range(from: number, to: number): PromiseLike<{ data: Record<string, string>[] | null; error: unknown }>;
};

/** How many `table` rows each id has in `column`, after `build`'s filters. */
async function countBy(table: string, column: string, ids: string[], build: (q: Filters) => Filters): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const supabase = createAdminClient();
  const { data, error } = await readInChunks<Record<string, string>>(ids, (chunk) =>
    readAllRows<Record<string, string>>((from, to) =>
      build(supabase.from(table).select(column).in(column, chunk) as unknown as Filters).order(column).range(from, to)
    )
  );
  if (error) throw error;
  for (const r of data ?? []) counts.set(r[column], (counts.get(r[column]) ?? 0) + 1);
  return counts;
}

async function shopExtras(ids: string[], now: Date): Promise<Map<string, VendorListExtras>> {
  const { start } = todayBounds(now);
  const supabase = createAdminClient();
  const [open, docs, complaints, todayRows] = await Promise.all([
    openStates(ids),
    countBy("vendor_documents", "restaurant_id", ids, (q) => q.eq("status", "pending")),
    countBy("support_tickets", "restaurant_id", ids, (q) => q.in("status", OPEN_TICKET_STATUSES as unknown as string[])),
    readInChunks<{ restaurant_id: string; payment_method: string | null; payment_status: string | null }>(ids, (chunk) =>
      readAllRows((from, to) =>
        supabase
          .from("orders")
          .select("id, restaurant_id, payment_method, payment_status")
          .in("restaurant_id", chunk)
          .gte("created_at", start)
          .order("id")
          .range(from, to)
          .overrideTypes<{ restaurant_id: string; payment_method: string | null; payment_status: string | null }[]>()
      )
    ),
  ]);
  if (todayRows.error) throw todayRows.error;
  const today = new Map<string, number>();
  for (const o of todayRows.data ?? []) {
    if (!isCountedOrder({ paymentMethod: o.payment_method, paymentStatus: o.payment_status } as Parameters<typeof isCountedOrder>[0])) continue;
    today.set(o.restaurant_id, (today.get(o.restaurant_id) ?? 0) + 1);
  }
  const out = new Map<string, VendorListExtras>();
  for (const id of ids) {
    out.set(id, {
      openState: open.get(id) ?? "closed",
      todayOrders: today.get(id) ?? 0,
      pendingDocuments: docs.get(id) ?? 0,
      openComplaints: complaints.get(id) ?? 0,
    });
  }
  return out;
}

/** Shops with a pending document or an open complaint (§4 "needs attention"). */
async function needingAttention(): Promise<string[]> {
  const supabase = createAdminClient();
  const [docs, tickets] = await Promise.all([
    readAllRows<{ restaurant_id: string }>((from, to) =>
      supabase.from("vendor_documents").select("restaurant_id").eq("status", "pending").order("restaurant_id").range(from, to)
    ),
    readAllRows<{ restaurant_id: string | null }>((from, to) =>
      supabase
        .from("support_tickets")
        .select("restaurant_id")
        .not("restaurant_id", "is", null)
        .in("status", OPEN_TICKET_STATUSES as unknown as string[])
        .order("restaurant_id")
        .range(from, to)
    ),
  ]);
  if (docs.error) throw docs.error;
  if (tickets.error) throw tickets.error;
  return [...new Set([...(docs.data ?? []), ...(tickets.data ?? [])].map((r) => r.restaurant_id).filter((x): x is string => !!x))];
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface VendorListResult {
  items: VendorListItem[];
  nextCursor: string | null;
  counts: VendorCounts;
}

export async function listManagerVendors(scope: ManagerScope, q: VendorQuery, now: Date): Promise<VendorListResult> {
  const effective = narrowScope(scope, q.zone);
  const supabase = createAdminClient();
  const term = q.q ? searchTerm(q.q) : "";

  // Filters every count shares: scope, search and category — never the status filter.
  const common = <T,>(query: T): T => {
    let out = applyZoneScope(query as unknown as Filters, effective);
    if (term) out = out.or(`name.ilike.*${term}*,slug.ilike.*${term}*`);
    if (q.category) out = out.eq("category", q.category);
    return out as unknown as T;
  };

  let attention: string[] | null = null;
  if (q.filter === "needs_attention") attention = await needingAttention();

  let query = common(supabase.from("restaurants").select(LIST_COLUMNS));
  const statuses = new Set<string>(q.statuses);
  if (q.filter === "active" || q.filter === "online") statuses.add("active");
  if (q.filter === "pending") statuses.add("pending");
  if (statuses.size > 0) query = query.in("status", [...statuses]);
  if (q.filter === "online") query = query.eq("is_open", true);
  if (attention) query = query.in("id", attention.length > 0 ? attention : ["00000000-0000-0000-0000-000000000000"]);
  if (q.cursor) {
    query = query.or(`name.gt.${pgQuote(q.cursor.name)},and(name.eq.${pgQuote(q.cursor.name)},id.gt.${q.cursor.id})`);
  }
  const { data, error } = await query
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(q.limit + 1)
    .overrideTypes<RawListRow[]>();
  if (error) throw error;

  const rows = (data ?? []).map(flattenZone);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > q.limit && last ? encodeNameCursor(last.name ?? "", last.id) : null;

  const [extras, counts] = await Promise.all([shopExtras(page.map((r) => r.id), now), vendorCounts(common)]);
  let items = page.map((r) => toVendorListItem(r, extras.get(r.id)!));
  if (q.filter === "online") items = items.filter((i) => i.openState === "open");
  return { items, nextCursor, counts };
}

async function vendorCounts(common: <T>(q: T) => T): Promise<VendorCounts> {
  const supabase = createAdminClient();
  const count = async (status?: VendorStatus) => {
    let q = common(supabase.from("restaurants").select("id", { count: "exact", head: true }));
    if (status) q = q.eq("status", status);
    const { count: n, error } = await q;
    if (error) throw error;
    return n ?? 0;
  };
  const activeOpen = await readAllRows<{ id: string }>((from, to) =>
    common(supabase.from("restaurants").select("id"))
      .eq("status", "active")
      .eq("is_open", true)
      .order("id")
      .range(from, to)
  );
  if (activeOpen.error) throw activeOpen.error;
  const [all, pending, active, suspended, rejected, inactive, open] = await Promise.all([
    count(), count("pending"), count("active"), count("suspended"), count("rejected"), count("inactive"),
    openStates((activeOpen.data ?? []).map((r) => r.id)),
  ]);
  const online = [...open.values()].filter((s) => s === "open").length;
  return { all, pending, active, suspended, rejected, inactive, online };
}

// ── detail ───────────────────────────────────────────────────────────────────

/** The shop row if the scope may see it, else null (missing and out of scope alike). */
export async function scopedVendorRow(scope: ManagerScope, id: string): Promise<RawDetailRow & { zone_name: string | null } | null> {
  const { data, error } = await applyZoneScope(
    createAdminClient().from("restaurants").select(DETAIL_COLUMNS).eq("id", id),
    scope
  ).maybeSingle<RawDetailRow>();
  if (error) throw error;
  if (!data || !scopeAllows(scope, data.zone_id)) return null;
  return flattenZone(data);
}

async function profileNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const { data, error } = await createAdminClient().from("profiles").select("id, full_name").in("id", unique);
  if (error) throw error;
  for (const p of (data ?? []) as { id: string; full_name: string | null }[]) names.set(p.id, p.full_name?.trim() || "Staff");
  return names;
}

const DOCUMENT_COLUMNS = "id, doc_type, file_name, status, remarks, reviewed_by, reviewed_at, created_at";

export async function listVendorDocumentItems(restaurantId: string) {
  const { data, error } = await createAdminClient()
    .from("vendor_documents")
    .select(DOCUMENT_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false })
    .overrideTypes<DocumentRow[]>();
  if (error) throw error;
  const rows = data ?? [];
  const names = await profileNames(rows.map((r) => r.reviewed_by));
  return rows.map((r) => toVendorDocument(r, names));
}

/** The last 30 IST days, today included. */
export function performanceRange(now: Date): DateRange {
  const to = istDayKey(now);
  return { from: addDays(to, -29), to };
}

export async function getManagerVendorDetail(
  scope: ManagerScope,
  id: string,
  ctx: { permissions: Record<string, boolean>; now: Date }
): Promise<VendorDetail | null> {
  const row = await scopedVendorRow(scope, id);
  if (!row) return null;
  const supabase = createAdminClient();
  const range = performanceRange(ctx.now);
  const { day } = todayBounds(ctx.now);
  const financeOn = ctx.permissions["manager.finance.view"] === true;

  const [extras, names, documents, holidays, orders, rateRows, ratings, complaints] = await Promise.all([
    shopExtras([id], ctx.now),
    profileNames([row.status_changed_by]),
    listVendorDocumentItems(id),
    supabase.from("store_holidays").select("starts_on, ends_on, note").eq("restaurant_id", id).gte("ends_on", day).order("starts_on"),
    loadMetricOrders(scope, { range, restaurantId: id }),
    readAllRows<{ status: string; cancelled_by: string | null; created_at: string; accepted_at: string | null; ready_at: string | null;
      payment_method: string | null; payment_status: string | null }>((from, to) =>
      supabase
        .from("orders")
        .select("id, status, cancelled_by, created_at, accepted_at, ready_at, payment_method, payment_status")
        .eq("restaurant_id", id)
        .gte("created_at", istDayStart(range.from).toISOString())
        .lt("created_at", istDayStart(addDays(range.to, 1)).toISOString())
        .order("id")
        .range(from, to)
    ),
    readAllRows<{ rating: number }>((from, to) =>
      supabase.from("reviews").select("id, rating").eq("restaurant_id", id).eq("status", "published").order("id").range(from, to)
    ),
    supabase
      .from("support_tickets")
      .select(TICKET_COLUMNS)
      .eq("restaurant_id", id)
      .in("status", OPEN_TICKET_STATUSES as unknown as string[])
      .order("created_at", { ascending: false })
      .limit(10)
      .overrideTypes<TicketRow[]>(),
  ]);
  if (holidays.error) throw holidays.error;
  if (rateRows.error) throw rateRows.error;
  if (ratings.error) throw ratings.error;
  if (complaints.error) throw complaints.error;

  const refunds = await loadRefunds(orders.map((o) => o.id));
  const summary = salesSummary(orders, refunds);
  const rates = vendorRates(
    (rateRows.data ?? [])
      .filter((o) => isCountedOrder({ paymentMethod: o.payment_method, paymentStatus: o.payment_status } as Parameters<typeof isCountedOrder>[0]))
      .map((o) => ({ status: o.status, cancelledBy: o.cancelled_by, createdAt: o.created_at, acceptedAt: o.accepted_at, readyAt: o.ready_at }))
  );
  const listItem = toVendorListItem(row, extras.get(id)!);

  let finance: VendorFinance | null = null;
  if (financeOn) finance = await vendorFinance(id, row.settlement_cycle, orders, refunds);

  const docItems = documents;
  const detail = buildVendorDetail(
    {
      row,
      extras: extras.get(id)!,
      statusChangedBy: row.status_changed_by ? { id: row.status_changed_by, name: names.get(row.status_changed_by) ?? "Staff" } : null,
      documents: docItems,
      holidays: (holidays.data ?? []) as { starts_on: string; ends_on: string; note: string | null }[],
      performance: {
        from: range.from,
        to: range.to,
        orders: summary.orders,
        sales: summary.customerPaid,
        aov: summary.averageOrderValue,
        cancellationRate: round3(rates.cancellationRate),
        rejectionRate: round3(rates.rejectionRate),
        avgAcceptMinutes: round1(rates.avgAcceptMinutes),
        avgPrepMinutes: round1(rates.avgPrepMinutes),
        rating: listItem.rating,
        ratingCount: listItem.ratingCount,
        ratingDistribution: ratingDistribution((ratings.data ?? []).map((r) => r.rating)),
      },
      finance,
      openComplaints: (complaints.data ?? []).map(toTicketSummary),
      allowed: allowedVendorActions({ status: listItem.status }, ctx.permissions),
    },
    ctx.permissions
  );
  return detail;
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * §4.11–4.12. Pending payment is ops_vendor_dues (0145) — the dashboard's dues
 * arithmetic for one shop, all-time; commission this period is every platform
 * deduction (commission, its GST, other charges) on the performance window's
 * orders, as the dashboard's Total Platform Commission counts it.
 */
async function vendorFinance(
  id: string,
  settlementCycle: string | null,
  orders: Awaited<ReturnType<typeof loadMetricOrders>>,
  refunds: Awaited<ReturnType<typeof loadRefunds>>
): Promise<VendorFinance> {
  const supabase = createAdminClient();
  const [pricing, platformDefault, gst, settlements] = await Promise.all([
    loadPricing([id]),
    getVendorCommissionDefault(),
    getCommissionGstPct(),
    supabase
      .from("vendor_settlements")
      .select("id, period_start, period_end, net_payable, status, paid_at, payment_ref")
      .eq("restaurant_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  if (settlements.error) throw settlements.error;
  const dues = await supabase.rpc("ops_vendor_dues", { p_restaurant: id, p_commission_default: platformDefault, p_gst_pct: gst });
  if (dues.error) throw dues.error;
  const net = Number((dues.data as { net: number } | null)?.net ?? 0);
  return {
    commissionPct: pricing.commissionPct.get(id) ?? platformDefault,
    commissionGstPct: pricing.commissionGstPct,
    otherChargesPerOrder: pricing.otherCharges.get(id) ?? 0,
    settlementCycle,
    pendingPayment: Math.max(0, net),
    recoverable: Math.max(0, -net),
    commissionThisPeriod: platformCommission(orders, refunds, pricing).total,
    settlements: ((settlements.data ?? []) as {
      id: string; period_start: string; period_end: string; net_payable: number; status: "draft" | "paid" | "void";
      paid_at: string | null; payment_ref: string | null;
    }[]).map((s) => ({
      id: s.id,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      netPayable: s.net_payable,
      status: s.status,
      paidAt: s.paid_at,
      paymentRef: s.payment_ref,
    })),
  };
}

// ── reviews, complaints, documents ───────────────────────────────────────────

const REVIEW_COLUMNS =
  "id, rating, comment, created_at, status, order_id, food_quality, packaging, delivery_experience, value_for_money, " +
  "profiles(full_name), review_replies(reply_text, created_at, removed_at)";

function keysetDesc<Q extends { or(f: string): Q }>(query: Q, cursor: string | null): Q | null {
  if (!cursor) return query;
  const c = decodeCursor(cursor);
  if (!c) return null;
  return query.or(`created_at.lt.${pgQuote(c.createdAt)},and(created_at.eq.${pgQuote(c.createdAt)},id.lt.${c.id})`);
}

export async function listVendorReviews(
  scope: ManagerScope,
  id: string,
  cursor: string | null,
  limit: number
): Promise<{ items: ReviewItem[]; nextCursor: string | null } | null> {
  if (!(await scopedVendorRow(scope, id))) return null;
  const query = keysetDesc(createAdminClient().from("reviews").select(REVIEW_COLUMNS).eq("restaurant_id", id), cursor);
  if (!query) return { items: [], nextCursor: null };
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1)
    .overrideTypes<ReviewRow[]>();
  if (error) throw error;
  const rows = data ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(toReviewItem), nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function listVendorComplaints(
  scope: ManagerScope,
  id: string,
  statuses: string[],
  cursor: string | null,
  limit = 50
): Promise<{ items: TicketSummary[]; nextCursor: string | null } | null> {
  if (!(await scopedVendorRow(scope, id))) return null;
  let base = createAdminClient().from("support_tickets").select(TICKET_COLUMNS).eq("restaurant_id", id);
  if (statuses.length > 0) base = base.in("status", statuses);
  const query = keysetDesc(base, cursor);
  if (!query) return { items: [], nextCursor: null };
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1)
    .overrideTypes<TicketRow[]>();
  if (error) throw error;
  const rows = data ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(toTicketSummary), nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

/** A 60-second signed URL for one of the shop's documents, or null (missing or out of scope). */
export async function vendorDocumentUrl(
  scope: ManagerScope,
  id: string,
  docId: string
): Promise<{ url: string; expiresAt: string } | null> {
  if (!(await scopedVendorRow(scope, id))) return null;
  const { data, error } = await createAdminClient()
    .from("vendor_documents")
    .select("storage_path")
    .eq("id", docId)
    .eq("restaurant_id", id)
    .maybeSingle<{ storage_path: string }>();
  if (error) throw error;
  if (!data) return null;
  const url = await signedDocumentUrl(data.storage_path, 60);
  if (!url) return null;
  return { url, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

/** For the stats route's vendor filter: is this shop in scope? */
export async function vendorInScope(scope: ManagerScope, id: string): Promise<boolean> {
  const zones = scopeZoneIds(scope);
  let q = createAdminClient().from("restaurants").select("id, zone_id").eq("id", id);
  if (zones) q = q.in("zone_id", zones as string[]);
  const { data, error } = await q.maybeSingle<{ id: string; zone_id: string }>();
  if (error) throw error;
  return !!data && scopeAllows(scope, data.zone_id);
}

/** One shop in a filter picker (Orders, Products, Statistics). */
export interface VendorDirectoryEntry {
  id: string;
  name: string;
  status: VendorStatus;
  zoneId: string | null;
  zoneName: string | null;
}

/**
 * Every shop the manager may filter by — all statuses, zone-scoped, by name.
 * Small rows and no paging contract: a city has hundreds of shops, not
 * hundreds of thousands, and a picker needs them all.
 */
export async function listVendorDirectory(scope: ManagerScope): Promise<VendorDirectoryEntry[]> {
  const zones = scopeZoneIds(scope);
  const { data, error } = await readAllRows<RawListRow>((from, to) => {
    let q = createAdminClient().from("restaurants").select("id, name, status, zone_id, delivery_zones(name)");
    if (zones) q = q.in("zone_id", zones as string[]);
    return q.order("name", { ascending: true }).order("id", { ascending: true }).range(from, to) as never;
  });
  if (error) throw error;
  return data
    .filter((r) => scopeAllows(scope, r.zone_id))
    .map(flattenZone)
    .map((r) => ({
      id: r.id,
      name: r.name?.trim() || "Unnamed shop",
      status: r.status as VendorStatus,
      zoneId: r.zone_id ?? null,
      zoneName: r.zone_name,
    }));
}
