import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { delayFor } from "@/lib/ops/live-rules";
import { ACTIVE_ORDER_STATUSES, type DbOrderStatus, type DeliveryStatus, type OrderDetail, type OrderListItem } from "@/lib/ops/order-contract";
import { mergeTimeline, toOrderDetail, type ActorIn } from "@/lib/ops/order-detail";
import { encodeCursor, type OrderQuery } from "@/lib/ops/order-query";
import { liveFacts, toOrderListItem, type OpsOrderRow } from "@/lib/ops/order-row";

/**
 * The Manager app's order reads (§3). Service role, so every `orders` read is
 * filtered to the caller's zones here (scopeZoneIds) — the route's
 * managerApiContext() is the authorization, this is the scope. Explicit
 * column lists only: `orders` is column-granted (AGENTS.md rule 1) and two of
 * its columns are handover codes no manager screen needs.
 *
 * Assumes migrations through 0142 (lifecycle stamps, channel, prep_minutes,
 * zone_id, short_code): the Manager app does not run on an older database.
 */

const DELIVERY_COLS = "status, driver_id, picked_up_at, failed_at";
const LIST_COLS = [
  "id, status, created_at, accepted_at, ready_at, cancelled_at, prep_minutes, zone_id, restaurant_id",
  "total, payment_method, payment_status, channel, cancelled_by, cancellation_reason, address",
  "restaurants(id, name, lat, lng, eta_min, eta_max)",
  "order_items(id)",
  "customer:profiles!orders_customer_id_fkey(full_name)",
].join(", ");

/** The most active orders one queue read walks; far above any real board. */
const ACTIVE_CAP = 1000;

interface Address { label?: string; line?: string; landmark?: string; lat?: number; lng?: number }
interface ListRow {
  id: string;
  status: DbOrderStatus;
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  cancelled_at: string | null;
  prep_minutes: number | null;
  zone_id: string | null;
  restaurant_id: string;
  total: number | null;
  payment_method: string | null;
  payment_status: string | null;
  channel: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  address: Address | null;
  restaurants: Shop | Shop[] | null;
  order_items: { id: string }[] | null;
  customer: { full_name: string | null } | { full_name: string | null }[] | null;
  deliveries: DeliveryRef | DeliveryRef[] | null;
}
interface Shop { id: string; name: string | null; lat: number | null; lng: number | null; eta_min: number | null; eta_max: number | null }
interface DeliveryRef { status: string; driver_id: string | null; picked_up_at: string | null; failed_at: string | null }

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export interface RiderInfo { name: string; code: string | null; phone: string | null }

/** Names, rider IDs and phones for a set of riders, in two reads. */
export async function loadRiderInfo(ids: string[]): Promise<Map<string, RiderInfo>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, RiderInfo>();
  if (unique.length === 0) return out;
  const supabase = createAdminClient();
  const [{ data: people }, { data: codes }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, phone").in("id", unique),
    supabase.from("rider_profiles").select("driver_id, rider_code").in("driver_id", unique),
  ]);
  const codeOf = new Map(((codes ?? []) as { driver_id: string; rider_code: string | null }[]).map((c) => [c.driver_id, c.rider_code]));
  for (const p of (people ?? []) as { id: string; full_name: string | null; phone: string | null }[]) {
    out.set(p.id, { name: p.full_name?.trim() || "Rider", code: codeOf.get(p.id) ?? null, phone: p.phone });
  }
  return out;
}

export function toOpsRow(r: ListRow, riders: Map<string, RiderInfo>): OpsOrderRow {
  const shop = one(r.restaurants);
  const d = one(r.deliveries);
  const a = r.address ?? {};
  const rider = d?.driver_id ? riders.get(d.driver_id) : undefined;
  return {
    id: r.id,
    status: r.status,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    readyAt: r.ready_at,
    prepMinutes: r.prep_minutes,
    zoneId: r.zone_id,
    etaMin: shop?.eta_min ?? null,
    etaMax: shop?.eta_max ?? null,
    vendor: { id: shop?.id ?? r.restaurant_id, name: shop?.name?.trim() || "Restaurant", lat: shop?.lat ?? null, lng: shop?.lng ?? null },
    drop: typeof a.lat === "number" && typeof a.lng === "number" ? { lat: a.lat, lng: a.lng } : null,
    customerName: one(r.customer)?.full_name?.trim() || null,
    total: r.total ?? 0,
    itemCount: r.order_items?.length ?? 0,
    payment: { method: r.payment_method, status: r.payment_status },
    byPhone: r.channel === "phone",
    delivery: d ? { status: d.status, driverId: d.driver_id, pickedUpAt: d.picked_up_at, failedAt: d.failed_at } : null,
    riderName: rider?.name ?? null,
    riderCode: rider?.code ?? null,
    cancelledBy: r.cancelled_by,
    cancellationReason: r.cancellation_reason,
    cancelledAt: r.cancelled_at,
  };
}

async function withRiders(rows: ListRow[]): Promise<OpsOrderRow[]> {
  const riders = await loadRiderInfo(rows.map((r) => one(r.deliveries)?.driver_id ?? "").filter(Boolean));
  return rows.map((r) => toOpsRow(r, riders));
}

/** Every non-terminal order in scope (the queues, the counts, the live map). */
export async function loadActiveOrderRows(scope: ManagerScope, extra?: OrderQuery): Promise<OpsOrderRow[]> {
  const supabase = createAdminClient();
  const deliveries = extra?.rider ? `deliveries!inner(${DELIVERY_COLS})` : `deliveries(${DELIVERY_COLS})`;
  let query: Chain = supabase
    .from("orders")
    .select(`${LIST_COLS}, ${deliveries}`)
    .in("status", ACTIVE_ORDER_STATUSES as DbOrderStatus[]);
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  if (extra) query = applyFilters(query, extra);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(ACTIVE_CAP);
  if (error) throw error;
  return withRiders((data ?? []) as unknown as ListRow[]);
}

// The builder's generic is too deep to name; the filters only chain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function applyFilters(query: Chain, q: OrderQuery): Chain {
  let out = query;
  if (q.q?.kind === "id") out = out.eq("id", q.q.id);
  if (q.q?.kind === "code") out = out.like("short_code", `${q.q.prefix}%`);
  if (q.from) out = out.gte("created_at", q.from);
  if (q.to) out = out.lt("created_at", q.to);
  if (q.vendor) out = out.eq("restaurant_id", q.vendor);
  if (q.rider) out = out.eq("deliveries.driver_id", q.rider);
  if (q.paymentMethods) out = out.in("payment_method", q.paymentMethods);
  if (q.paymentStatuses) out = out.in("payment_status", q.paymentStatuses);
  return out;
}

/** Specific orders in scope (any status), e.g. those whose delivery just failed. */
export async function loadOrderRowsByIds(scope: ManagerScope, ids: string[]): Promise<OpsOrderRow[]> {
  if (ids.length === 0) return [];
  const supabase = createAdminClient();
  let query: Chain = supabase.from("orders").select(`${LIST_COLS}, deliveries(${DELIVERY_COLS})`).in("id", ids);
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  const { data, error } = await query;
  if (error) throw error;
  return withRiders((data ?? []) as unknown as ListRow[]);
}

export interface OrderListResult {
  items: OrderListItem[];
  nextCursor: string | null;
  counts: { delayed: number; unassigned: number };
}

export async function listManagerOrders(scope: ManagerScope, q: OrderQuery, opts: { now: Date }): Promise<OrderListResult> {
  const { now } = opts;

  // Counts for the queue chips: every active order in scope, unfiltered.
  const active = await loadActiveOrderRows(scope);
  const delays = active.map((o) => delayFor(liveFacts(o), now));
  const counts = {
    delayed: delays.filter(Boolean).length,
    unassigned: delays.filter((d) => d?.kind === "unassigned").length,
  };

  if (q.queue === "delayed" || q.queue === "unassigned") {
    const rows = await loadActiveOrderRows(scope, q);
    const items = rows
      .map((r) => toOrderListItem(r, now))
      .filter((i) => (q.queue === "unassigned" ? i.delay?.kind === "unassigned" : i.delay !== null))
      .filter((i) => !q.statuses || q.statuses.includes(i.status));
    return { items, nextCursor: null, counts };
  }

  const supabase = createAdminClient();
  const deliveries = q.rider ? `deliveries!inner(${DELIVERY_COLS})` : `deliveries(${DELIVERY_COLS})`;
  let query: Chain = supabase.from("orders").select(`${LIST_COLS}, ${deliveries}`);
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  query = applyFilters(query, q);
  const statuses = q.queue === "cancelled" ? ["cancelled"] : q.statuses;
  if (statuses) query = query.in("status", statuses);
  if (q.cursor) {
    const c = q.cursor;
    query = query.or(`created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.lt.${c.id})`);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as ListRow[];
  const page = rows.slice(0, q.limit);
  const ops = await withRiders(page);
  const last = page[page.length - 1];
  return {
    items: ops.map((r) => toOrderListItem(r, now)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    counts,
  };
}

const DETAIL_COLS = [
  LIST_COLS,
  "delivery_fee, tax_amount, tip, discount",
  "shop:restaurants(name, address, landmark, lat, lng, owner_mobile)",
  "lines:order_items(id, name, qty, price)",
  "buyer:profiles!orders_customer_id_fkey(full_name, phone)",
  "deliveries(id, status, driver_id, offered_driver_id, assigned_at, picked_up_at, delivered_at, failed_at, failure_reason, driver_lat, driver_lng, driver_location_at)",
].join(", ");

interface DetailRow extends ListRow {
  delivery_fee: number | null;
  tax_amount: number | null;
  tip: number | null;
  discount: number | null;
  shop: { name: string | null; address: string | null; landmark: string | null; lat: number | null; lng: number | null; owner_mobile: string | null }
    | { name: string | null; address: string | null; landmark: string | null; lat: number | null; lng: number | null; owner_mobile: string | null }[] | null;
  lines: { id: string; name: string; qty: number; price: number }[] | null;
  buyer: { full_name: string | null; phone: string | null } | { full_name: string | null; phone: string | null }[] | null;
  deliveries: FullDelivery | FullDelivery[] | null;
}
interface FullDelivery extends DeliveryRef {
  id: string;
  offered_driver_id: string | null;
  assigned_at: string | null;
  delivered_at: string | null;
  failure_reason: string | null;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_location_at: string | null;
}

/** The detail of one order in scope, or null — missing and out of scope look the same. */
export async function getManagerOrderDetail(
  scope: ManagerScope,
  id: string,
  ctx: { permissions: Record<string, boolean>; now: Date }
): Promise<OrderDetail | null> {
  const supabase = createAdminClient();
  let query: Chain = supabase.from("orders").select(DETAIL_COLS).eq("id", id);
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as DetailRow;
  const d = one(r.deliveries);

  const [statusEv, deliveryEv, notes, audits, tickets, fix] = await Promise.all([
    supabase.from("order_status_events").select("created_at, kind, from_status, to_status, actor_id, reason").eq("order_id", id).order("created_at"),
    supabase.from("delivery_events").select("created_at, kind, driver_id, actor_id, reason, method").eq("order_id", id).order("created_at"),
    supabase.from("order_ops_notes").select("created_at, author_id, body").eq("order_id", id).order("created_at"),
    supabase.from("ops_audit_log").select("created_at, action, actor_id, reason, before, after").eq("entity_type", "order").eq("entity_id", id).order("created_at"),
    supabase.from("support_tickets").select("id, number, status, priority").eq("order_id", id).order("created_at"),
    d?.driver_id
      ? supabase.from("rider_status").select("last_lat, last_lng, last_fix_at").eq("driver_id", d.driver_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  type SE = { created_at: string; kind: string; from_status: string | null; to_status: string | null; actor_id: string | null; reason: string | null };
  type DE = { created_at: string; kind: string; driver_id: string | null; actor_id: string | null; reason: string | null; method: string | null };
  type NE = { created_at: string; author_id: string; body: string };
  type AE = { created_at: string; action: string; actor_id: string; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
  const se = (statusEv.data ?? []) as SE[];
  const de = (deliveryEv.data ?? []) as DE[];
  const ne = (notes.data ?? []) as NE[];
  const ae = (audits.data ?? []) as AE[];

  const actorIds = [...se.map((e) => e.actor_id), ...de.map((e) => e.actor_id), ...ne.map((n) => n.author_id), ...ae.map((a) => a.actor_id)]
    .filter((x): x is string => !!x);
  const riderIds = [d?.driver_id, d?.offered_driver_id].filter((x): x is string => !!x);
  const [actorRows, riders] = await Promise.all([
    actorIds.length
      ? supabase.from("profiles").select("id, full_name, role").in("id", [...new Set(actorIds)])
      : Promise.resolve({ data: [] }),
    loadRiderInfo(riderIds),
  ]);
  const actors = new Map<string, ActorIn>(
    ((actorRows.data ?? []) as { id: string; full_name: string | null; role: string }[])
      .map((p) => [p.id, { id: p.id, name: p.full_name?.trim() || "Someone", role: String(p.role) }])
  );

  const timeline = mergeTimeline(
    se.map((e) => ({ at: e.created_at, kind: e.kind, from: e.from_status, to: e.to_status, actorId: e.actor_id, reason: e.reason })),
    de.map((e) => ({ at: e.created_at, kind: e.kind, driverId: e.driver_id, actorId: e.actor_id, reason: e.reason, method: e.method })),
    ne.map((n) => ({ at: n.created_at, authorId: n.author_id, body: n.body })),
    ae.map((a) => ({ at: a.created_at, action: a.action, actorId: a.actor_id, reason: a.reason, before: a.before, after: a.after })),
    actors
  );

  const row = toOpsRow(r, riders);
  const shop = one(r.shop);
  const buyer = one(r.buyer);
  const a = r.address ?? {};
  const lines = r.lines ?? [];
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);

  let delivery: OrderDetail["delivery"] = null;
  if (d) {
    const active = d.status === "assigned" || d.status === "picked_up";
    const st = fix.data as { last_lat: number | null; last_lng: number | null; last_fix_at: string | null } | null;
    // Prefer the rider's own latest fix; fall back to the delivery row. Shown
    // only while the delivery is in flight — never a trail of a finished one.
    const candidates = [
      st?.last_fix_at && st.last_lat != null && st.last_lng != null ? { lat: st.last_lat, lng: st.last_lng, at: st.last_fix_at } : null,
      d.driver_location_at && d.driver_lat != null && d.driver_lng != null ? { lat: d.driver_lat, lng: d.driver_lng, at: d.driver_location_at } : null,
    ].filter((x): x is { lat: number; lng: number; at: string } => x !== null)
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    const best = active ? candidates[0] : undefined;
    const rider = d.driver_id ? riders.get(d.driver_id) : undefined;
    const offered = d.offered_driver_id ? riders.get(d.offered_driver_id) : undefined;
    delivery = {
      id: d.id,
      status: d.status as DeliveryStatus,
      rider: d.driver_id && rider && d.status !== "unassigned"
        ? { id: d.driver_id, name: rider.name, code: rider.code, phone: rider.phone }
        : null,
      offeredTo: d.offered_driver_id && offered ? { id: d.offered_driver_id, name: offered.name } : null,
      assignedAt: d.assigned_at,
      pickedUpAt: d.picked_up_at,
      deliveredAt: d.delivered_at,
      failedAt: d.failed_at,
      failureReason: d.failure_reason,
      lastFix: best
        ? { lat: best.lat, lng: best.lng, at: best.at, ageSeconds: Math.max(0, Math.floor((ctx.now.getTime() - Date.parse(best.at)) / 1000)) }
        : null,
    };
  }

  return toOrderDetail(
    row,
    {
      items: lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, price: l.price })),
      money: {
        subtotal,
        discount: r.discount ?? 0,
        deliveryFee: r.delivery_fee ?? 0,
        tax: r.tax_amount ?? 0,
        tip: r.tip ?? 0,
        total: r.total ?? 0,
      },
      pickup: {
        name: shop?.name?.trim() || row.vendor.name,
        address: [shop?.address, shop?.landmark].filter(Boolean).join(", ") || null,
        lat: shop?.lat ?? null,
        lng: shop?.lng ?? null,
        phone: shop?.owner_mobile ?? null,
      },
      drop: {
        label: a.label ?? null,
        address: a.line ?? null,
        landmark: a.landmark ?? null,
        lat: typeof a.lat === "number" ? a.lat : null,
        lng: typeof a.lng === "number" ? a.lng : null,
      },
      customer: { name: buyer?.full_name?.trim() || null, phone: buyer?.phone ?? null },
      delivery,
      timeline,
      tickets: ((tickets.data ?? []) as { id: string; number: number; status: string; priority: string }[])
        .map((t) => ({ id: t.id, number: Number(t.number), status: t.status, priority: t.priority })),
    },
    ctx.permissions,
    ctx.now
  );
}
