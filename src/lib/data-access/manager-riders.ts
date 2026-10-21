import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, type ManagerScope } from "@/lib/auth/manager-scope";
import { scopedRiderIds } from "@/lib/data-access/scoped-riders";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { loadOrderRowsByIds } from "@/lib/data-access/manager-ops-orders";
import { getRiderHistory, getRiderHistoryTotals, performanceInputs } from "@/lib/data-access/rider-insights";
import { toOrderListItem } from "@/lib/ops/order-row";
import { orderShortCode } from "@/lib/ops/order-contract";
import { encodeNameCursor, OPEN_TICKET_STATUSES, TICKET_COLUMNS, toTicketSummary, type PersonRef, type TicketRow } from "@/lib/ops/vendor-contract";
import {
  encodeTimeCursor,
  type ActiveDelivery,
  type HistoryQuery,
  type LedgerQuery,
  type LedgerRow,
  type Payout,
  type RiderCounts,
  type RiderDetail,
  type RiderDocType,
  type RiderHistoryItem,
  type RiderListItem,
  type RiderQuery,
  type RiderState,
  type Verification,
  type Account,
} from "@/lib/ops/rider-contract";
import { buildRiderDetail, riderState, type RiderDetailInput } from "@/lib/ops/rider-rules";
import {
  CASH_DEPOSIT_COLUMNS,
  CASH_DISPUTE_COLUMNS,
  EXCEPTION_COLUMNS,
  PAYMENT_REQUEST_COLUMNS,
  serializeException,
  toCashDeposit,
  toCashDispute,
  toPaymentRequest,
  type CashDepositRow,
  type CashDisputeRow,
  type ExceptionRow,
  type Names,
  type PaymentRequestRow,
  type Viewer,
} from "@/lib/ops/rider-serialize";
import { istDay, monthsOf, performanceOf } from "@/lib/rider/figures";
import type { ManagerApiContext } from "@/lib/auth/manager-api.server";
import { withPaymentSettings } from "@/lib/data-access/payment-approvals";

/** Who is looking: the viewer every serialiser decides `canDecide` and `decisions` for. */
export function viewerOf(ctx: ManagerApiContext): Viewer {
  return { id: ctx.profile.id, perms: ctx.permissions, isAdmin: ctx.profile.role === "admin" };
}

/**
 * Manager riders (§5): list, detail, history, ratings, ledger and document
 * links. Every read is the service role, so every read is scoped here: riders
 * through `scopedRiderIds` / `applyRiderScope` (the riders who share one of the
 * manager's zones; every rider for an admin), and an id outside the scope reads
 * as absent (the routes answer 404).
 *
 * Callers authorise first (managerApiContext + the route's switch).
 */

const DOCS_BUCKET = "rider-documents";
const IST_OFFSET_MS = 330 * 60_000;

function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

// ── shared reads ──────────────────────────────────────────────────────────────

interface ProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  account_status?: string | null;
  status_reason?: string | null;
  status_changed_by?: string | null;
  status_changed_at?: string | null;
}

const PROFILE_COLS = "id, full_name, phone, avatar_url, created_at";
const ACCOUNT_COLS = "account_status, status_reason, status_changed_by, status_changed_at";

/** Driver profiles for `ids` (null = every driver), with the account columns when 0151 is applied. */
async function loadDriverProfiles(ids: readonly string[] | null): Promise<ProfileRow[]> {
  const supabase = createAdminClient();
  const read = async (cols: string) => {
    if (ids === null) {
      return readAllRows<ProfileRow>((from, to) =>
        supabase.from("profiles").select(cols).eq("role", "driver").order("id").range(from, to) as unknown as PromiseLike<{ data: ProfileRow[] | null; error: unknown }>
      );
    }
    return readInChunks<ProfileRow>(ids, (chunk) =>
      supabase.from("profiles").select(cols).eq("role", "driver").in("id", chunk) as unknown as PromiseLike<{ data: ProfileRow[] | null; error: unknown }>
    );
  };
  let res = await read(`${PROFILE_COLS}, ${ACCOUNT_COLS}`);
  if (res.error && isMissingColumn(res.error as { code?: string })) res = await read(PROFILE_COLS);
  if (res.error) throw res.error;
  return res.data;
}

interface StatusRow { driver_id: string; is_online: boolean; break_until: string | null; online_since: string | null; last_lat: number | null; last_lng: number | null; last_fix_at: string | null }
interface RiderProfileRow {
  driver_id: string; rider_code: string | null; created_at: string;
  verification_status?: string | null; verified_at?: string | null; verified_by?: string | null;
  vehicle_type?: string | null; vehicle_owner?: string | null; vehicle_registration?: string | null;
  licence_number?: string | null; licence_expires_on?: string | null; address_line?: string | null; pincode?: string | null;
  emergency_name?: string | null; emergency_phone?: string | null; emergency_relation?: string | null;
}
interface FactRow {
  driver_id: string; active_deliveries: number; delivered_today: number; rating_avg: number | string | null; rating_count: number;
  pending_docs: number; expiring_docs: number; open_complaints: number;
}

const RIDER_PROFILE_FULL =
  "driver_id, rider_code, created_at, verification_status, verified_at, verified_by, vehicle_type, vehicle_owner, vehicle_registration, " +
  "licence_number, licence_expires_on, address_line, pincode, emergency_name, emergency_phone, emergency_relation";

async function loadByRider<T>(table: string, cols: string, ids: readonly string[], column = "driver_id"): Promise<T[]> {
  if (ids.length === 0) return [];
  const supabase = createAdminClient();
  const res = await readInChunks<T>(ids, (chunk) =>
    supabase.from(table).select(cols).in(column, chunk) as unknown as PromiseLike<{ data: T[] | null; error: unknown }>
  );
  if (res.error) {
    if (isMissingTable(res.error as { code?: string })) return [];
    throw res.error;
  }
  return res.data;
}

async function loadRiderProfiles(ids: readonly string[]): Promise<RiderProfileRow[]> {
  try {
    return await loadByRider<RiderProfileRow>("rider_profiles", RIDER_PROFILE_FULL, ids);
  } catch (e) {
    if (isMissingColumn(e as { code?: string })) return loadByRider<RiderProfileRow>("rider_profiles", "driver_id, rider_code, created_at", ids);
    throw e;
  }
}

async function loadZones(ids: readonly string[]): Promise<Map<string, { id: string; name: string }[]>> {
  const rows = await loadByRider<{ user_id: string; zone_id: string; delivery_zones: { name: string } | { name: string }[] | null }>(
    "staff_zones", "user_id, zone_id, delivery_zones(name)", ids, "user_id"
  );
  const out = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const z = Array.isArray(r.delivery_zones) ? r.delivery_zones[0] : r.delivery_zones;
    const list = out.get(r.user_id) ?? [];
    list.push({ id: r.zone_id, name: z?.name ?? "Zone" });
    out.set(r.user_id, list);
  }
  return out;
}

async function loadFacts(ids: readonly string[], now: Date): Promise<Map<string, FactRow>> {
  const out = new Map<string, FactRow>();
  if (ids.length === 0) return out;
  const supabase = createAdminClient();
  const res = await readInChunks<FactRow>(ids, (chunk) =>
    supabase.rpc("ops_rider_list_facts", { p_ids: chunk, p_day_start: istDayStart(now).toISOString() }) as unknown as PromiseLike<{ data: FactRow[] | null; error: unknown }>,
    200
  );
  if (res.error) throw res.error;
  for (const f of res.data) out.set(f.driver_id, f);
  return out;
}

/** Display names for staff / riders, one read. */
export async function loadPeople(ids: readonly (string | null | undefined)[]): Promise<Map<string, { name: string; code: string | null; phone: string | null }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, { name: string; code: string | null; phone: string | null }>();
  if (unique.length === 0) return out;
  const supabase = createAdminClient();
  const [people, codes] = await Promise.all([
    readInChunks<{ id: string; full_name: string | null; phone: string | null }>(unique, (c) =>
      supabase.from("profiles").select("id, full_name, phone").in("id", c) as unknown as PromiseLike<{ data: { id: string; full_name: string | null; phone: string | null }[] | null; error: unknown }>
    ),
    readInChunks<{ driver_id: string; rider_code: string | null }>(unique, (c) =>
      supabase.from("rider_profiles").select("driver_id, rider_code").in("driver_id", c) as unknown as PromiseLike<{ data: { driver_id: string; rider_code: string | null }[] | null; error: unknown }>
    ),
  ]);
  if (people.error) throw people.error;
  const codeOf = new Map((codes.error ? [] : codes.data).map((c) => [c.driver_id, c.rider_code]));
  for (const p of people.data) out.set(p.id, { name: p.full_name?.trim() || "Staff", code: codeOf.get(p.id) ?? null, phone: p.phone });
  return out;
}

export async function loadZoneNames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const { data, error } = await createAdminClient().from("delivery_zones").select("id, name").in("id", unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((z) => [z.id, z.name]));
}

/** The Names a serialiser needs, from people and zone maps. Rider phones only where `withPhones`. */
export function namesFrom(
  people: Map<string, { name: string; code: string | null; phone: string | null }>,
  zones: Map<string, string>,
  withPhones = true
): Names {
  return {
    person: (id) => (id ? { id, name: people.get(id)?.name ?? "Staff" } : null),
    rider: (id) => {
      const p = people.get(id);
      return { id, name: p?.name === "Staff" ? "Rider" : (p?.name ?? "Rider"), code: p?.code ?? null, phone: withPhones ? (p?.phone ?? null) : null };
    },
    zone: (id) => (id ? { id, name: zones.get(id) ?? "Zone" } : null),
  };
}

// ── list ─────────────────────────────────────────────────────────────────────

const ratingOf = (f: FactRow | undefined): number | null =>
  f?.rating_avg === null || f?.rating_avg === undefined ? null : Math.round(Number(f.rating_avg) * 10) / 10;

function fixAge(at: string | null, now: Date): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 1000)) : null;
}

/** A copy of each row without one key (an internal sort or filter field the contract does not carry). */
function withoutKey<K extends string>(key: K) {
  return <T extends Record<K, unknown>>(row: T): Omit<T, K> => {
    const copy = { ...row };
    delete (copy as Partial<T>)[key];
    return copy;
  };
}

const sortKey = (name: string | null) => (name?.trim() ? name.trim().toLowerCase() : "￿");

export async function listRidersForManager(
  scope: ManagerScope,
  q: RiderQuery,
  now: Date
): Promise<{ items: RiderListItem[]; nextCursor: string | null; counts: RiderCounts }> {
  const narrowed = q.zone ? narrowScope(scope, q.zone) : scope;
  const scoped = await scopedRiderIds(narrowed);
  const profiles = await loadDriverProfiles(scoped === null ? null : [...scoped]);
  const ids = profiles.map((p) => p.id);
  const [statuses, riderProfiles, zones, facts] = await Promise.all([
    loadByRider<StatusRow>("rider_status", "driver_id, is_online, break_until, online_since, last_lat, last_lng, last_fix_at", ids),
    loadRiderProfiles(ids),
    loadZones(ids),
    loadFacts(ids, now),
  ]);
  const statusOf = new Map(statuses.map((s) => [s.driver_id, s]));
  const rpOf = new Map(riderProfiles.map((r) => [r.driver_id, r]));

  const all = profiles.map((p): RiderListItem & { isOnline: boolean } => {
    const s = statusOf.get(p.id);
    const f = facts.get(p.id);
    const rp = rpOf.get(p.id);
    const active = f?.active_deliveries ?? 0;
    return {
      id: p.id,
      riderCode: rp?.rider_code ?? null,
      name: p.full_name?.trim() || null,
      phone: p.phone,
      photoUrl: p.avatar_url,
      state: riderState(
        {
          isOnline: s?.is_online ?? false,
          breakUntil: s?.break_until ? new Date(s.break_until) : null,
          lastFixAt: s?.last_fix_at ? new Date(s.last_fix_at) : null,
          activeDeliveries: active,
        },
        now
      ),
      lastFixAt: s?.last_fix_at ?? null,
      fixAgeSeconds: fixAge(s?.last_fix_at ?? null, now),
      zones: zones.get(p.id) ?? [],
      verification: ((rp?.verification_status as Verification | undefined) ?? "unverified"),
      account: ((p.account_status as Account | undefined) ?? "active"),
      activeDeliveries: active,
      deliveredToday: f?.delivered_today ?? 0,
      rating: ratingOf(f),
      ratingCount: f?.rating_count ?? 0,
      pendingDocuments: f?.pending_docs ?? 0,
      expiringDocuments: f?.expiring_docs ?? 0,
      openComplaints: f?.open_complaints ?? 0,
      isOnline: s?.is_online ?? false,
    };
  });

  // Search, verification, account and the review filters narrow what the
  // counts describe; the state chips then pick from it.
  const needle = q.q?.toLowerCase() ?? null;
  const digits = q.q?.replace(/\D/g, "") ?? "";
  const base = all.filter((r) => {
    if (needle) {
      const hit = (r.name ?? "").toLowerCase().includes(needle)
        || (r.riderCode ?? "").toLowerCase().includes(needle)
        || (digits.length >= 4 && (r.phone ?? "").replace(/\D/g, "").includes(digits));
      if (!hit) return false;
    }
    if (q.verification && r.verification !== q.verification) return false;
    if (q.account && r.account !== q.account) return false;
    if (q.filter === "needs_review" && !(r.pendingDocuments > 0 || r.verification === "pending")) return false;
    if (q.filter === "expiring" && r.expiringDocuments === 0) return false;
    return true;
  });

  const counts: RiderCounts = {
    all: base.length,
    online: base.filter((r) => r.isOnline).length,
    available: base.filter((r) => r.state === "available").length,
    on_delivery: base.filter((r) => r.state === "on_delivery").length,
    break: base.filter((r) => r.state === "break").length,
    stale: base.filter((r) => r.state === "stale").length,
    offline: base.filter((r) => r.state === "offline").length,
    suspended: base.filter((r) => r.account === "suspended").length,
    needs_review: base.filter((r) => r.pendingDocuments > 0 || r.verification === "pending").length,
  };

  const wanted = new Set<RiderState>(q.states);
  const matched = base
    .filter((r) => wanted.size === 0 || wanted.has(r.state) || (wanted.has("online") && r.isOnline))
    .sort((a, b) => {
      const ka = sortKey(a.name);
      const kb = sortKey(b.name);
      return ka === kb ? (a.id < b.id ? -1 : 1) : ka < kb ? -1 : 1;
    });
  const after = q.cursor
    ? matched.filter((r) => {
        const k = sortKey(r.name);
        return k > q.cursor!.name || (k === q.cursor!.name && r.id > q.cursor!.id);
      })
    : matched;
  const page = after.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(withoutKey("isOnline")),
    nextCursor: after.length > q.limit && last ? encodeNameCursor(sortKey(last.name), last.id) : null,
    counts,
  };
}

// ── scope check ──────────────────────────────────────────────────────────────

/** Is this a driver the caller may see? A failed read throws (the route answers 500, never "yes"). */
export async function riderVisible(scope: ManagerScope, riderId: string): Promise<boolean> {
  const ids = await scopedRiderIds(scope);
  if (ids !== null) return ids.has(riderId);
  const { data, error } = await createAdminClient().from("profiles").select("id").eq("id", riderId).eq("role", "driver").maybeSingle();
  if (error) throw error;
  return data !== null;
}

// ── detail ───────────────────────────────────────────────────────────────────

interface DocRow {
  id: string; doc_type: RiderDocType; number: string | null; expires_on: string | null; status: string; remarks: string | null;
  reviewed_by: string | null; reviewed_at: string | null; created_at: string;
}

async function activeDeliveries(scope: ManagerScope, riderId: string, now: Date, riderPos: { lat: number; lng: number } | null): Promise<ActiveDelivery[]> {
  const { data, error } = await createAdminClient()
    .from("deliveries")
    .select("order_id, status")
    .eq("driver_id", riderId)
    .in("status", ["assigned", "picked_up"]);
  if (error) throw error;
  const legs = (data ?? []) as { order_id: string; status: "assigned" | "picked_up" }[];
  if (legs.length === 0) return [];
  const rows = await loadOrderRowsByIds(scope, legs.map((l) => l.order_id));
  const statusOf = new Map(legs.map((l) => [l.order_id, l.status]));
  return rows.map((row) => {
    const item = toOrderListItem(row, now);
    const status = statusOf.get(row.id) ?? "assigned";
    const shop = { name: row.vendor.name, lat: row.vendor.lat ?? 0, lng: row.vendor.lng ?? 0 };
    const drop = { area: null, lat: row.drop?.lat ?? 0, lng: row.drop?.lng ?? 0 };
    // A straight-line route through the stops still ahead (rider → shop → drop,
    // or rider → drop once picked up): the live module has no road routing, and
    // an empty route is better than an invented one when a point is unknown.
    const stops: [number, number][] = [];
    if (riderPos) stops.push([riderPos.lat, riderPos.lng]);
    if (status === "assigned" && row.vendor.lat !== null && row.vendor.lng !== null) stops.push([row.vendor.lat, row.vendor.lng]);
    if (row.drop) stops.push([row.drop.lat, row.drop.lng]);
    return {
      orderId: row.id,
      code: item.code,
      status,
      shop,
      drop,
      etaPickupAt: item.eta?.pickupAt ?? null,
      etaDeliveryAt: item.eta?.expectedAt ?? null,
      route: stops.length >= 2 ? stops : [],
      delay: item.delay ? { kind: item.delay.kind, minutes: item.delay.minutes } : null,
    };
  });
}

async function ratingsSummary(riderId: string): Promise<RiderDetail["ratings"]> {
  const supabase = createAdminClient();
  const stars = [1, 2, 3, 4, 5] as const;
  const [counts, recent] = await Promise.all([
    Promise.all(stars.map((s) => supabase.from("rider_ratings").select("id", { count: "exact", head: true }).eq("driver_id", riderId).eq("rating", s))),
    supabase.from("rider_ratings").select("rating, comment, created_at, order_id").eq("driver_id", riderId).order("created_at", { ascending: false }).limit(5),
  ]);
  for (const c of counts) if (c.error && !isMissingTable(c.error)) throw c.error;
  if (recent.error && !isMissingTable(recent.error)) throw recent.error;
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } as RiderDetail["ratings"]["distribution"];
  stars.forEach((s, i) => (distribution[String(s) as "1"] = counts[i].count ?? 0));
  const count = Object.values(distribution).reduce((a, b) => a + b, 0);
  const sum = stars.reduce((acc, s) => acc + s * distribution[String(s) as "1"], 0);
  return {
    average: count ? Math.round((sum / count) * 10) / 10 : null,
    count,
    distribution,
    recent: ((recent.data ?? []) as { rating: number; comment: string | null; created_at: string; order_id: string }[]).map((r) => ({
      rating: r.rating,
      comment: r.comment,
      at: r.created_at,
      orderCode: orderShortCode(r.order_id),
    })),
  };
}

async function openComplaints(riderId: string): Promise<RiderDetail["openComplaints"]> {
  const supabase = createAdminClient();
  const { data: recent } = await supabase
    .from("deliveries")
    .select("order_id")
    .eq("driver_id", riderId)
    .order("assigned_at", { ascending: false })
    .limit(200);
  const orderIds = ((recent ?? []) as { order_id: string }[]).map((r) => r.order_id);
  const open = OPEN_TICKET_STATUSES as unknown as string[];
  const [mine, onOrders] = await Promise.all([
    supabase.from("support_tickets").select(TICKET_COLUMNS).eq("requester_id", riderId).in("status", open).order("created_at", { ascending: false }).limit(10),
    orderIds.length
      ? supabase.from("support_tickets").select(TICKET_COLUMNS).in("order_id", orderIds.slice(0, 100)).in("status", open).order("created_at", { ascending: false }).limit(10)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [mine, onOrders]) if (r.error && !isMissingTable(r.error as { code?: string })) throw r.error;
  const byId = new Map<string, TicketRow>();
  for (const t of [...((mine.data ?? []) as TicketRow[]), ...((onOrders.data ?? []) as TicketRow[])]) byId.set(t.id, t);
  return [...byId.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 10)
    .map(toTicketSummary);
}

export async function getRiderForManager(
  scope: ManagerScope,
  id: string,
  viewer: Viewer,
  now: Date
): Promise<RiderDetail | null> {
  if (!(await riderVisible(scope, id))) return null;
  const supabase = createAdminClient();
  const today = istDay(now);
  const paymentViewer = await withPaymentSettings(viewer);
  const [profiles, riderProfiles, statuses, zones, facts, docs, perfInputs, ratings, complaints, deposits, disputes, exceptions, requests, money, cash, lastPayout] =
    await Promise.all([
      loadDriverProfiles([id]),
      loadRiderProfiles([id]),
      loadByRider<StatusRow>("rider_status", "driver_id, is_online, break_until, online_since, last_lat, last_lng, last_fix_at", [id]),
      loadZones([id]),
      loadFacts([id], now),
      loadByRider<DocRow>("rider_documents", "id, doc_type, number, expires_on, status, remarks, reviewed_by, reviewed_at, created_at", [id]),
      performanceInputs(id, new Date(now.getTime() - 183 * 86_400_000)),
      ratingsSummary(id),
      openComplaints(id),
      supabase.from("cash_deposits").select(CASH_DEPOSIT_COLUMNS).eq("driver_id", id).eq("status", "submitted").order("created_at"),
      supabase.from("cash_disputes").select(CASH_DISPUTE_COLUMNS).eq("driver_id", id).eq("status", "open").order("created_at"),
      supabase.from("delivery_exceptions").select(EXCEPTION_COLUMNS).eq("driver_id", id).eq("status", "pending").order("created_at"),
      supabase.from("payment_requests").select(PAYMENT_REQUEST_COLUMNS).eq("kind", "rider_payout").eq("subject_id", id).eq("status", "pending_approval"),
      supabase.rpc("ops_rider_money_summary", { p_rider: id }),
      supabase.rpc("ops_rider_cash_position", { p_rider: id, p_today: today }),
      supabase.from("rider_payouts").select("id, amount, method, reference, paid_on, period_end, request_id").eq("driver_id", id)
        .order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(1),
    ]);
  const p = profiles[0];
  if (!p) return null;
  for (const r of [deposits, disputes, exceptions, requests, lastPayout]) {
    if (r.error && !isMissingTable(r.error as { code?: string })) throw r.error;
  }
  if (money.error) throw money.error;
  if (cash.error) throw cash.error;

  const rp = riderProfiles[0];
  const st = statuses[0];
  const f = facts.get(id);
  const depositRows = (deposits.data ?? []) as CashDepositRow[];
  const disputeRows = (disputes.data ?? []) as CashDisputeRow[];
  const exceptionRows = (exceptions.data ?? []) as ExceptionRow[];
  const requestRows = (requests.data ?? []) as PaymentRequestRow[];
  const docRows = docs;
  const people = await loadPeople([
    id, p.status_changed_by, rp?.verified_by,
    ...docRows.map((d) => d.reviewed_by),
    ...depositRows.map((d) => d.decided_by),
    ...exceptionRows.map((e) => e.decided_by),
    ...requestRows.flatMap((r) => [r.requested_by, r.decided_by]),
  ]);
  const zoneNames = await loadZoneNames(requestRows.map((r) => r.zone_id));
  const names = namesFrom(people, zoneNames);

  const from30 = new Date(now.getTime() - 30 * 86_400_000);
  const in30 = perfInputs.deliveries.filter((d) => Date.parse(d.endedAt) >= from30.getTime());
  const ev30 = perfInputs.events.filter((e) => Date.parse(e.at) >= from30.getTime());
  const perf = performanceOf(in30, ev30, perfInputs.shifts, from30, now);
  const riderPos = st?.last_lat != null && st?.last_lng != null ? { lat: st.last_lat, lng: st.last_lng } : null;
  const active = await activeDeliveries(scope, id, now, riderPos);

  const m = (money.data ?? {}) as { pending?: number | string; paid_total?: number | string };
  const c = (cash.data ?? {}) as { collected_today?: number; deposited_today?: number; pending_deposit?: number };
  const lp = ((lastPayout.data ?? []) as { id: string; amount: number | string; method: Payout["method"]; reference: string | null; paid_on: string; period_end: string; request_id: string | null }[])[0];

  const input: RiderDetailInput = {
    id,
    riderCode: rp?.rider_code ?? null,
    name: p.full_name?.trim() || null,
    phone: p.phone,
    photoUrl: p.avatar_url,
    isOnline: st?.is_online ?? false,
    breakUntil: st?.break_until ?? null,
    onlineSince: st?.online_since ?? null,
    lastFixAt: st?.last_fix_at ?? null,
    lat: st?.last_lat ?? null,
    lng: st?.last_lng ?? null,
    zones: zones.get(id) ?? [],
    verification: (rp?.verification_status as Verification | undefined) ?? "unverified",
    account: (p.account_status as Account | undefined) ?? "active",
    accountReason: p.status_reason ?? null,
    accountChangedAt: p.status_changed_at ?? null,
    accountChangedBy: names.person(p.status_changed_by),
    verifiedAt: rp?.verified_at ?? null,
    verifiedBy: names.person(rp?.verified_by),
    activeDeliveries: f?.active_deliveries ?? active.length,
    deliveredToday: f?.delivered_today ?? 0,
    rating: ratings.average,
    ratingCount: ratings.count,
    pendingDocuments: f?.pending_docs ?? 0,
    expiringDocuments: f?.expiring_docs ?? 0,
    openComplaintsCount: complaints.length,
    profile: {
      vehicleType: (rp?.vehicle_type as RiderDetail["profile"]["vehicleType"]) ?? null,
      vehicleOwner: (rp?.vehicle_owner as "deligro" | "rider" | null) ?? "deligro",
      vehicleRegistration: rp?.vehicle_registration ?? null,
      licenceNumber: rp?.licence_number ?? null,
      licenceExpiresOn: rp?.licence_expires_on ?? null,
      address: rp?.address_line ?? null,
      pincode: rp?.pincode ?? null,
      emergency: { name: rp?.emergency_name ?? null, phone: rp?.emergency_phone ?? null, relation: rp?.emergency_relation ?? null },
      joinedAt: rp?.created_at ?? p.created_at,
    },
    active,
    performance: {
      from: istDay(from30),
      to: today,
      ...perf,
      months: monthsOf(perfInputs.deliveries, perfInputs.events, perfInputs.shifts, now),
    },
    ratings,
    documents: docRows
      .filter((d) => d.status !== "replaced")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((d) => ({
        id: d.id,
        type: d.doc_type,
        number: d.number,
        expiresOn: d.expires_on,
        status: d.status as RiderDetailInput["documents"][number]["status"],
        remarks: d.remarks,
        reviewedBy: names.person(d.reviewed_by),
        reviewedAt: d.reviewed_at,
        uploadedAt: d.created_at,
      })),
    money: {
      pending: Number(m.pending ?? 0),
      paidTotal: Number(m.paid_total ?? 0),
      lastPayout: lp
        ? { id: lp.id, amount: Number(lp.amount), method: lp.method, reference: lp.reference, paidOn: lp.paid_on, periodEnd: lp.period_end, items: await payoutItemCount(lp.id), requestId: lp.request_id }
        : null,
      pendingRequests: requestRows.map((r) => toPaymentRequest(r, names, paymentViewer)),
    },
    cash: {
      collectedToday: c.collected_today ?? 0,
      depositedToday: c.deposited_today ?? 0,
      pendingDeposit: c.pending_deposit ?? 0,
      openDeposits: depositRows.map((d) => toCashDeposit(d, names)),
      openDisputes: disputeRows.map((d) => toCashDispute(d, names)),
    },
    openExceptions: exceptionRows.map((e) => serializeException(e, names, viewer.perms)),
    openComplaints: complaints,
  };
  return buildRiderDetail(input, viewer.perms, now);
}

async function payoutItemCount(payoutId: string): Promise<number> {
  const supabase = createAdminClient();
  const counts = await Promise.all(
    ["rider_earnings", "rider_incentive_awards", "rider_adjustments"].map((t) =>
      supabase.from(t).select("id", { count: "exact", head: true }).eq("payout_id", payoutId)
    )
  );
  return counts.reduce((sum, c) => sum + (c.error ? 0 : (c.count ?? 0)), 0);
}

// ── history and ratings ──────────────────────────────────────────────────────

export async function getRiderHistoryForManager(
  scope: ManagerScope,
  id: string,
  q: HistoryQuery
): Promise<{ items: RiderHistoryItem[]; nextCursor: string | null; totals: { delivered: number; failed: number; cancelled: number; reassigned: number } } | null> {
  if (!(await riderVisible(scope, id))) return null;
  const [page, totals] = await Promise.all([
    getRiderHistory(id, { from: q.from ?? undefined, to: q.to ?? undefined, outcome: q.outcome ?? undefined, cursor: q.cursor, limit: 50 }),
    getRiderHistoryTotals(id, { from: q.from, to: q.to }),
  ]);
  // The manager contract has no `earning` (riders are salaried, and pay lives in the ledger).
  return { items: page.items.map(withoutKey("earning")), nextCursor: page.nextCursor, totals };
}

export async function getRiderRatingsPage(
  scope: ManagerScope,
  id: string,
  cursor: { at: string; id: string } | null
): Promise<{ items: { rating: number; comment: string | null; at: string; orderCode: string }[]; nextCursor: string | null } | null> {
  if (!(await riderVisible(scope, id))) return null;
  let query = createAdminClient()
    .from("rider_ratings")
    .select("id, rating, comment, created_at, order_id")
    .eq("driver_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(51);
  if (cursor) query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return { items: [], nextCursor: null };
    throw error;
  }
  const rows = (data ?? []) as { id: string; rating: number; comment: string | null; created_at: string; order_id: string }[];
  const page = rows.slice(0, 50);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ rating: r.rating, comment: r.comment, at: r.created_at, orderCode: orderShortCode(r.order_id) })),
    nextCursor: rows.length > 50 && last ? encodeTimeCursor(last.created_at, last.id) : null,
  };
}

// ── ledger ───────────────────────────────────────────────────────────────────

export interface LedgerPage {
  items: LedgerRow[];
  nextCursor: string | null;
  payouts: Payout[];
  summary: { pending: number; paid: number };
}

export async function getRiderLedger(scope: ManagerScope, id: string, q: LedgerQuery): Promise<LedgerPage | null> {
  if (!(await riderVisible(scope, id))) return null;
  const supabase = createAdminClient();
  const [earnings, awards, adjustments, payouts, money] = await Promise.all([
    supabase.from("rider_earnings").select("id, order_id, earned_at, amount, payout_id").eq("driver_id", id),
    supabase.from("rider_incentive_awards").select("id, awarded_at, amount, payout_id").eq("driver_id", id),
    supabase.from("rider_adjustments").select("id, kind, amount, reason, order_id, effective_on, created_by, payout_id").eq("driver_id", id),
    supabase.from("rider_payouts").select("id, amount, method, reference, paid_on, period_end, request_id, created_at").eq("driver_id", id)
      .order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(50),
    supabase.rpc("ops_rider_money_summary", { p_rider: id }),
  ]);
  for (const r of [earnings, awards, adjustments, payouts]) if (r.error && !isMissingTable(r.error)) throw r.error;
  if (money.error) throw money.error;

  type Adj = { id: string; kind: LedgerRow["type"]; amount: number | string; reason: string; order_id: string | null; effective_on: string; created_by: string; payout_id: string | null };
  const adjRows = (adjustments.data ?? []) as Adj[];
  const people = await loadPeople(adjRows.map((a) => a.created_by));
  const names = namesFrom(people, new Map());

  const rows: (LedgerRow & { sortAt: string })[] = [
    ...((earnings.data ?? []) as { id: string; order_id: string; earned_at: string; amount: number | string; payout_id: string | null }[]).map((e) => ({
      id: e.id, type: "earning" as const, amount: Number(e.amount), date: istDay(e.earned_at), reason: null,
      orderCode: orderShortCode(e.order_id), payoutId: e.payout_id, status: e.payout_id ? ("paid" as const) : ("pending" as const),
      createdBy: null, sortAt: e.earned_at,
    })),
    ...((awards.data ?? []) as { id: string; awarded_at: string; amount: number | string; payout_id: string | null }[]).map((a) => ({
      id: a.id, type: "incentive" as const, amount: Number(a.amount), date: istDay(a.awarded_at), reason: "Incentive target reached",
      orderCode: null, payoutId: a.payout_id, status: a.payout_id ? ("paid" as const) : ("pending" as const), createdBy: null, sortAt: a.awarded_at,
    })),
    ...adjRows.map((a) => ({
      id: a.id, type: a.kind, amount: Number(a.amount), date: a.effective_on, reason: a.reason,
      orderCode: a.order_id ? orderShortCode(a.order_id) : null, payoutId: a.payout_id,
      status: a.payout_id ? ("paid" as const) : ("pending" as const), createdBy: names.person(a.created_by) as PersonRef | null,
      sortAt: `${a.effective_on}T23:59:59.999+05:30`,
    })),
  ];
  const filtered = rows
    .filter((r) => (!q.from || r.date >= q.from) && (!q.to || r.date <= q.to) && (!q.status || r.status === q.status))
    .map((r) => ({ ...r, sortAt: new Date(r.sortAt).toISOString() }))
    .sort((a, b) => (a.sortAt === b.sortAt ? (a.id < b.id ? 1 : -1) : a.sortAt < b.sortAt ? 1 : -1));
  const after = q.cursor
    ? filtered.filter((r) => r.sortAt < q.cursor!.at || (r.sortAt === q.cursor!.at && r.id < q.cursor!.id))
    : filtered;
  const page = after.slice(0, 50);
  const last = page[page.length - 1];

  const payoutRows = (payouts.data ?? []) as { id: string; amount: number | string; method: Payout["method"]; reference: string | null; paid_on: string; period_end: string; request_id: string | null }[];
  const itemsPer = new Map<string, number>();
  for (const r of rows) if (r.payoutId) itemsPer.set(r.payoutId, (itemsPer.get(r.payoutId) ?? 0) + 1);
  const m = (money.data ?? {}) as { pending?: number | string; paid_total?: number | string };
  return {
    items: page.map(withoutKey("sortAt")),
    nextCursor: after.length > 50 && last ? encodeTimeCursor(last.sortAt, last.id) : null,
    payouts: payoutRows.map((p) => ({
      id: p.id, amount: Number(p.amount), method: p.method, reference: p.reference, paidOn: p.paid_on, periodEnd: p.period_end,
      items: itemsPer.get(p.id) ?? 0, requestId: p.request_id,
    })),
    summary: { pending: Number(m.pending ?? 0), paid: Number(m.paid_total ?? 0) },
  };
}

// ── document links ───────────────────────────────────────────────────────────

/** A 60-second signed link to one of this rider's documents, after the scope check. */
export async function riderDocumentUrlForManager(
  scope: ManagerScope,
  riderId: string,
  docId: string
): Promise<{ url: string; expiresAt: string } | null> {
  if (!(await riderVisible(scope, riderId))) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("rider_documents")
    .select("file_path")
    .eq("id", docId)
    .eq("driver_id", riderId)
    .maybeSingle<{ file_path: string }>();
  if (error) throw error;
  if (!data) return null;
  const { data: signed } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(data.file_path, 60);
  if (!signed?.signedUrl) return null;
  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

