import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyZoneScope, narrowScope, scopeAllows, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyCampaignWindow, notifyMarketingDecision } from "@/lib/notifications/marketing";
import { loadNameBook, type NameBook } from "@/lib/data-access/ops-names";
import { getOfferSummaries } from "@/lib/data-access/manager-offers";
import { istDayKey, rangeBounds } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics/types";
import type { BannerFields, CampaignInput } from "@/lib/marketing/campaign-rules";
import type { CampaignPerformance } from "@/lib/marketing/attribution";
import { imageKind } from "@/lib/marketing/image-kind";
import {
  dbKind, mapMarketingRpcError, nextCursor, REQUEST_STATUSES, requestType, serializeCampaign, serializeCampaignDetail,
  serializeRequest, type CampaignDetail, type CampaignHeadline, type CampaignQuery, type CampaignRow, type CampaignSummary,
  type CreateRequestBody, type DecideBody, type MarketingRequest, type Names, type RequestQuery, type RequestRow, type RequestStatus,
} from "@/lib/ops/marketing-contract";
import type { OfferSummary } from "@/lib/ops/offer-contract";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

/**
 * Manager marketing (§8): requests, campaigns, the scheduler and the
 * customer-facing campaign reads. Every write is one 0160 RPC that re-checks
 * the actor's zone and audits in the same transaction; reads are service-role
 * and always zone-scoped here (applyZoneScope). Callers authorise first
 * (managerApiContext("manager.marketing.manage")).
 */

const REQUEST_COLUMNS =
  "id, number, restaurant_id, zone_id, source, kind, title, details, starts_on, ends_on, budget, menu_item_ids, proposed_offer, " +
  "attachment_path, status, admin_remarks, requested_by, decided_by, decided_at, campaign_id, offer_code, created_at, updated_at";
const CAMPAIGN_COLUMNS =
  "id, kind, title, zone_id, restaurant_id, status, starts_at, ends_at, budget, funded_by, vendor_share_pct, slot_position, banner_id, " +
  "offer_code, request_id, notes, created_by, cancelled_reason, created_at, updated_at";

const db = () => createAdminClient();
type Fail = Extract<OpsResult, { ok: false }>;
const NOT_FOUND: Fail = { ok: false, status: 404, error: "not_found" };

function names(book: NameBook): Names {
  return { shop: book.shop, zone: book.zone, person: book.person, item: book.item };
}

/** Keyset on (created_at desc, id desc). */
function afterCursor<Q extends { or(filter: string): Q }>(q: Q, c: { createdAt: string; id: string } | null): Q {
  return c ? q.or(`created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`) : q;
}

// ── requests ─────────────────────────────────────────────────────────────

export async function listMarketingRequests(scope: ManagerScope, q: RequestQuery): Promise<{
  items: MarketingRequest[]; nextCursor: string | null; counts: Record<RequestStatus, number>;
}> {
  const zones = scopeZoneIds(narrowScope(scope, q.zoneId));
  const filtered = (cols: string, head = false) => {
    let x = db().from("marketing_requests").select(cols, head ? { count: "exact", head: true } : undefined);
    if (zones) x = x.in("zone_id", [...zones]);
    if (q.type) x = x.eq("kind", dbKind(q.type));
    if (q.vendorId) x = x.eq("restaurant_id", q.vendorId);
    return x;
  };
  let list = filtered(REQUEST_COLUMNS);
  if (q.status) list = list.eq("status", q.status);
  list = afterCursor(list, q.cursor).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1);
  const [{ data, error }, ...countRes] = await Promise.all([
    list,
    ...REQUEST_STATUSES.map((st) => filtered("id", true).eq("status", st)),
  ]);
  if (error) throw error;
  const rows = (data ?? []) as unknown as RequestRow[];
  const page = rows.slice(0, q.limit);
  const book = await loadNameBook({
    shops: page.map((r) => r.restaurant_id), zones: page.map((r) => r.zone_id),
    people: page.flatMap((r) => [r.requested_by, r.decided_by]), items: page.flatMap((r) => r.menu_item_ids ?? []),
  });
  const counts = Object.fromEntries(REQUEST_STATUSES.map((st, i) => [st, countRes[i].count ?? 0])) as Record<RequestStatus, number>;
  return { items: page.map((r) => serializeRequest(r, names(book))), nextCursor: nextCursor(rows, q.limit), counts };
}

/** The request row, if it is in scope. */
async function scopedRequest(scope: ManagerScope, id: string): Promise<RequestRow | null> {
  const { data, error } = await db().from("marketing_requests").select(REQUEST_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  const row = data as unknown as RequestRow | null;
  return row && scopeAllows(scope, row.zone_id) ? row : null;
}

export async function getMarketingRequest(scope: ManagerScope, id: string, now: Date): Promise<{
  request: MarketingRequest; campaign: CampaignSummary | null; offer: OfferSummary | null;
} | null> {
  const row = await scopedRequest(scope, id);
  if (!row) return null;
  const book = await loadNameBook({ shops: [row.restaurant_id], zones: [row.zone_id], people: [row.requested_by, row.decided_by],
    items: row.menu_item_ids ?? [] });
  let attachmentUrl: string | null = null;
  if (row.attachment_path) {
    const { data } = await db().storage.from("marketing-attachments").createSignedUrl(row.attachment_path, 60);
    attachmentUrl = data?.signedUrl ?? null;
  }
  const [campaign, offers] = await Promise.all([
    row.campaign_id ? listCampaignSummaries(scope, [row.campaign_id], now).then((l) => l[0] ?? null) : Promise.resolve(null),
    row.offer_code ? getOfferSummaries(scope, [row.offer_code], now) : Promise.resolve([] as OfferSummary[]),
  ]);
  return { request: serializeRequest(row, names(book), attachmentUrl), campaign, offer: offers[0] ?? null };
}

export async function requestTypeOf(scope: ManagerScope, id: string) {
  const row = await scopedRequest(scope, id);
  return row ? requestType(row.kind) : null;
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await db().rpc(name, args);
  return { data: data as Record<string, unknown> | null, error: error as { code?: string; message?: string; details?: string | null } | null };
}

export async function createMarketingRequestOps(actor: OpsActor, scope: ManagerScope, b: CreateRequestBody): Promise<OpsResult & { id?: string }> {
  const { data: shop } = await db().from("restaurants").select("zone_id").eq("id", b.vendorId).maybeSingle();
  if (!shop || !scopeAllows(scope, (shop as { zone_id: string | null }).zone_id)) return NOT_FOUND;
  const { data, error } = await rpc("ops_create_marketing_request", {
    p_actor: actor.id, p_restaurant: b.vendorId, p_type: b.type, p_title: b.title, p_details: b.details,
    p_preferred_start: b.preferredStart, p_preferred_end: b.preferredEnd, p_budget: b.budget, p_items: b.itemIds,
    p_proposed_offer: b.proposedOffer, p_client_action_id: b.clientActionId,
  });
  if (error) return mapMarketingRpcError(error);
  return { ok: true, id: String(data?.request_id) };
}

export async function decideMarketingRequestOps(actor: OpsActor, scope: ManagerScope, id: string, b: DecideBody): Promise<OpsResult> {
  const row = await scopedRequest(scope, id);
  if (!row) return NOT_FOUND;
  const { data, error } = await rpc("ops_decide_marketing_request", {
    p_actor: actor.id, p_request: id, p_decision: b.decision, p_expected: b.expected, p_remarks: b.remarks,
    p_campaign: b.campaign, p_offer: b.offer, p_client_action_id: b.clientActionId,
  });
  if (error) return mapMarketingRpcError(error);
  if (data?.replayed !== true) {
    deferNotify(() => notifyMarketingDecision(row.restaurant_id, id, row.title, b.decision === "approve" ? "approved" : "rejected", b.remarks));
  }
  return { ok: true };
}

export async function progressMarketingRequestOps(
  actor: OpsActor, scope: ManagerScope, id: string, status: "in_progress" | "completed", remarks: string | null, clientActionId: string,
): Promise<OpsResult> {
  const row = await scopedRequest(scope, id);
  if (!row) return NOT_FOUND;
  const { data, error } = await rpc("ops_progress_marketing_request", {
    p_actor: actor.id, p_request: id, p_status: status, p_remarks: remarks, p_client_action_id: clientActionId,
  });
  if (error) return mapMarketingRpcError(error);
  if (data?.replayed !== true) deferNotify(() => notifyMarketingDecision(row.restaurant_id, id, row.title, status, remarks));
  return { ok: true };
}

// ── campaigns ────────────────────────────────────────────────────────────

async function headlines(ids: string[]): Promise<Map<string, CampaignHeadline>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db().rpc("ops_campaign_headlines", { p_ids: ids });
  if (error) throw error;
  return new Map(((data ?? []) as { campaign_id: string; impressions: number; clicks: number; attributed_orders: number; attributed_sales: number }[])
    .map((h) => [h.campaign_id, { impressions: h.impressions, clicks: h.clicks, attributedOrders: h.attributed_orders, attributedSales: h.attributed_sales }]));
}

async function vendorsOf(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { data, error } = await db().from("campaign_vendors").select("campaign_id, restaurant_id").in("campaign_id", ids);
  if (error) throw error;
  for (const r of (data ?? []) as { campaign_id: string; restaurant_id: string }[]) {
    out.set(r.campaign_id, [...(out.get(r.campaign_id) ?? []), r.restaurant_id]);
  }
  return out;
}

async function summarize(rows: CampaignRow[], now: Date): Promise<CampaignSummary[]> {
  const ids = rows.map((r) => r.id);
  const [h, vendors] = await Promise.all([headlines(ids), vendorsOf(ids)]);
  const book = await loadNameBook({ zones: rows.map((r) => r.zone_id), shops: [...vendors.values()].flat() });
  return rows.map((r) => serializeCampaign(r, vendors.get(r.id) ?? [], names(book), now, h.get(r.id)));
}

async function listCampaignSummaries(scope: ManagerScope, ids: string[], now: Date): Promise<CampaignSummary[]> {
  const { data, error } = await applyZoneScope(db().from("campaigns").select(CAMPAIGN_COLUMNS).in("id", ids), scope);
  if (error) throw error;
  return summarize((data ?? []) as unknown as CampaignRow[], now);
}

function stateFilter<Q extends { eq(c: string, v: unknown): Q; in(c: string, v: readonly string[]): Q; lte(c: string, v: string): Q;
  gt(c: string, v: string): Q; or(f: string): Q }>(q: Q, state: CampaignQuery["state"], nowIso: string): Q {
  if (state === "scheduled") return q.eq("status", "approved").gt("starts_at", nowIso);
  if (state === "active") return q.in("status", ["approved", "in_progress"]).lte("starts_at", nowIso).gt("ends_at", nowIso);
  if (state === "expired") return q.or(`status.in.(completed,cancelled),ends_at.lte.${nowIso}`);
  return q;
}

export async function listCampaigns(scope: ManagerScope, q: CampaignQuery, now: Date): Promise<{
  items: CampaignSummary[]; nextCursor: string | null; counts: { scheduled: number; active: number; expired: number };
}> {
  const zones = scopeZoneIds(narrowScope(scope, q.zoneId));
  const nowIso = now.toISOString();
  let vendorCampaigns: string[] | null = null;
  if (q.vendorId) {
    const { data } = await db().from("campaign_vendors").select("campaign_id").eq("restaurant_id", q.vendorId).limit(1000);
    vendorCampaigns = ((data ?? []) as { campaign_id: string }[]).map((r) => r.campaign_id);
  }
  const base = (cols: string, head = false) => {
    let x = db().from("campaigns").select(cols, head ? { count: "exact", head: true } : undefined);
    if (zones) x = x.in("zone_id", [...zones]);
    if (q.kind) x = x.eq("kind", q.kind);
    if (vendorCampaigns) x = x.in("id", vendorCampaigns.length ? vendorCampaigns : ["00000000-0000-0000-0000-000000000000"]);
    return x;
  };
  const list = afterCursor(stateFilter(base(CAMPAIGN_COLUMNS), q.state, nowIso), q.cursor)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1);
  const [{ data, error }, sc, ac, ec] = await Promise.all([
    list,
    stateFilter(base("id", true), "scheduled", nowIso),
    stateFilter(base("id", true), "active", nowIso),
    stateFilter(base("id", true), "expired", nowIso),
  ]);
  if (error) throw error;
  const rows = (data ?? []) as unknown as CampaignRow[];
  return {
    items: await summarize(rows.slice(0, q.limit), now),
    nextCursor: nextCursor(rows, q.limit),
    counts: { scheduled: sc.count ?? 0, active: ac.count ?? 0, expired: ec.count ?? 0 },
  };
}

/** The campaign's default performance range: its window, clipped to today (IST). */
export function defaultCampaignRange(c: { starts_at: string; ends_at: string }, now: Date): DateRange {
  const from = istDayKey(c.starts_at);
  const last = istDayKey(new Date(Math.min(Date.parse(c.ends_at) - 1, now.getTime())));
  return { from, to: last < from ? from : last };
}

export async function getCampaign(scope: ManagerScope, id: string, now: Date, range: DateRange | null): Promise<{
  campaign: CampaignDetail; performance: CampaignPerformance;
} | null> {
  const { data, error } = await db().from("campaigns").select(CAMPAIGN_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  const c = data as unknown as CampaignRow | null;
  if (!c || !scopeAllows(scope, c.zone_id)) return null;
  const r = range ?? defaultCampaignRange(c, now);
  const { start, endExclusive } = rangeBounds(r);
  const [vendors, itemsRes, bannerRes, h, perf] = await Promise.all([
    vendorsOf([id]),
    db().from("campaign_items").select("menu_item_id").eq("campaign_id", id),
    c.banner_id ? db().from("banners").select("headline, description, cta_label, target_type, target_value, image_url, placements")
      .eq("id", c.banner_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    headlines([id]),
    db().rpc("ops_campaign_performance", { p_campaign: id, p_from: start.toISOString(), p_to: endExclusive.toISOString() }),
  ]);
  if (perf.error) throw perf.error;
  const itemIds = ((itemsRes.data ?? []) as { menu_item_id: string }[]).map((x) => x.menu_item_id);
  const b = bannerRes.data as { headline: string; description: string; cta_label: string; target_type: string; target_value: string | null;
    image_url: string | null; placements: string[] } | null;
  const banner: BannerFields | null = b ? { headline: b.headline, description: b.description, ctaLabel: b.cta_label,
    targetType: b.target_type as BannerFields["targetType"], targetValue: b.target_value, imageUrl: b.image_url, placements: b.placements } : null;
  const book = await loadNameBook({ zones: [c.zone_id], shops: vendors.get(id) ?? [], items: itemIds, people: [c.created_by] });
  const p = perf.data as Omit<CampaignPerformance, "from" | "to" | "ctr">;
  return {
    campaign: serializeCampaignDetail(c, vendors.get(id) ?? [], itemIds, banner, names(book), now, h.get(id) ?? { impressions: 0, clicks: 0, attributedOrders: 0, attributedSales: 0 }),
    performance: { from: r.from, to: r.to, ...p, ctr: p.impressions > 0 ? Math.round((p.clicks / p.impressions) * 1000) / 10 : 0 },
  };
}

export async function createCampaignOps(actor: OpsActor, scope: ManagerScope, input: CampaignInput, clientActionId: string): Promise<OpsResult & { id?: string }> {
  if (!scopeAllows(scope, input.zoneId)) return NOT_FOUND;
  const { data, error } = await rpc("ops_create_campaign", { p_actor: actor.id, p_input: input, p_client_action_id: clientActionId });
  if (error) return mapMarketingRpcError(error);
  return { ok: true, id: String(data?.campaign_id) };
}

async function scopedCampaign(scope: ManagerScope, id: string): Promise<{ zone_id: string } | null> {
  const { data } = await db().from("campaigns").select("zone_id").eq("id", id).maybeSingle();
  const row = data as { zone_id: string } | null;
  return row && scopeAllows(scope, row.zone_id) ? row : null;
}

export async function updateCampaignOps(actor: OpsActor, scope: ManagerScope, id: string, body: {
  expectedUpdatedAt: string; changes: Record<string, unknown>; reason: string | null; clientActionId: string;
}): Promise<OpsResult> {
  if (!(await scopedCampaign(scope, id))) return NOT_FOUND;
  const { error } = await rpc("ops_update_campaign", {
    p_actor: actor.id, p_campaign: id, p_expected_updated_at: body.expectedUpdatedAt, p_changes: body.changes,
    p_reason: body.reason, p_client_action_id: body.clientActionId,
  });
  return error ? mapMarketingRpcError(error) : { ok: true };
}

export async function campaignActionOps(actor: OpsActor, scope: ManagerScope, id: string, action: "cancel" | "end_now", reason: string,
  clientActionId: string): Promise<OpsResult> {
  if (!(await scopedCampaign(scope, id))) return NOT_FOUND;
  const { error } = await rpc("ops_campaign_action", { p_actor: actor.id, p_campaign: id, p_action: action, p_reason: reason,
    p_client_action_id: clientActionId });
  return error ? mapMarketingRpcError(error) : { ok: true };
}

const MAX_IMAGE = 2 * 1024 * 1024;


/** Store a banner image for a campaign in scope; the app then sets it with a PATCH (audited). */
export async function uploadCampaignImage(scope: ManagerScope, id: string, file: File): Promise<{ ok: true; imageUrl: string } | Fail> {
  if (!(await scopedCampaign(scope, id))) return NOT_FOUND;
  if (file.size <= 0 || file.size > MAX_IMAGE) return { ok: false, status: 400, error: "bad_request", extra: { field: "file" } };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (!kind) return { ok: false, status: 400, error: "bad_request", extra: { field: "file" } };
  const path = `${id}/${randomUUID()}.${kind}`;
  const store = db().storage.from("banner-images");
  const { error } = await store.upload(path, bytes, { contentType: kind === "jpg" ? "image/jpeg" : "image/png", upsert: false });
  if (error) throw error;
  return { ok: true, imageUrl: store.getPublicUrl(path).data.publicUrl };
}

// ── scheduler and customer-facing reads ──────────────────────────────────

let lastSync = 0;

/**
 * Advance stored campaign statuses to match their windows and tell the shops.
 * Throttled to once a minute per server; called by the dispatch sweep and by
 * marketing list reads. Customer surfaces never wait on it.
 */
export async function syncCampaigns(now: Date, opts: { force?: boolean } = {}): Promise<{ changed: string[] }> {
  if (!opts.force && now.getTime() - lastSync < 60_000) return { changed: [] };
  lastSync = now.getTime();
  const { data, error } = await db().rpc("ops_sync_campaign_states", { p_now: now.toISOString() });
  if (error) throw error;
  const res = (data ?? { started: [], ended: [] }) as { started: string[]; ended: string[] };
  const changed = [...res.started, ...res.ended];
  if (changed.length > 0) {
    const { data: rows } = await db().from("campaigns").select("id, title, restaurant_id, request_id").in("id", changed);
    for (const c of (rows ?? []) as { id: string; title: string; restaurant_id: string | null; request_id: string | null }[]) {
      if (!c.restaurant_id) continue;
      await notifyCampaignWindow(c.restaurant_id, c.title, c.request_id, res.started.includes(c.id) ? "started" : "ended").catch(() => {});
    }
  }
  return { changed };
}

let featuredCache: { at: number; rows: { campaignId: string; restaurantId: string; slot: number; zoneId: string }[] } | null = null;
let sponsoredCache: { at: number; map: Map<string, string> } | null = null;

/** Featured-store campaigns live right now (window, not status). Cached 60 s. */
export async function activeFeaturedCampaigns(now: Date): Promise<{ campaignId: string; restaurantId: string; slot: number; zoneId: string }[]> {
  if (featuredCache && now.getTime() - featuredCache.at < 60_000) return featuredCache.rows;
  const iso = now.toISOString();
  const { data, error } = await db().from("campaigns").select("id, restaurant_id, slot_position, zone_id")
    .eq("kind", "featured_store").neq("status", "cancelled").lte("starts_at", iso).gt("ends_at", iso).limit(200);
  if (error) return featuredCache?.rows ?? [];
  const rows = ((data ?? []) as { id: string; restaurant_id: string | null; slot_position: number | null; zone_id: string }[])
    .filter((r) => r.restaurant_id && r.slot_position)
    .map((r) => ({ campaignId: r.id, restaurantId: r.restaurant_id!, slot: r.slot_position!, zoneId: r.zone_id }));
  featuredCache = { at: now.getTime(), rows };
  return rows;
}

/** Sponsored dishes live right now: menu item id → campaign id. Cached 60 s. */
export async function activeSponsoredItems(now: Date): Promise<Map<string, string>> {
  if (sponsoredCache && now.getTime() - sponsoredCache.at < 60_000) return sponsoredCache.map;
  const iso = now.toISOString();
  const { data: camps, error } = await db().from("campaigns").select("id")
    .eq("kind", "sponsored_product").neq("status", "cancelled").lte("starts_at", iso).gt("ends_at", iso).limit(200);
  if (error) return sponsoredCache?.map ?? new Map();
  const ids = ((camps ?? []) as { id: string }[]).map((c) => c.id);
  const map = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await db().from("campaign_items").select("campaign_id, menu_item_id").in("campaign_id", ids);
    for (const r of (data ?? []) as { campaign_id: string; menu_item_id: string }[]) map.set(r.menu_item_id, r.campaign_id);
  }
  sponsoredCache = { at: now.getTime(), map };
  return map;
}

/** Is this campaign inside its window now? (The public track route records only then.) */
export async function campaignIsLive(id: string, now: Date): Promise<boolean> {
  const { data } = await db().from("campaigns").select("status, starts_at, ends_at").eq("id", id).maybeSingle();
  const c = data as { status: string; starts_at: string; ends_at: string } | null;
  return !!c && c.status !== "cancelled" && Date.parse(c.starts_at) <= now.getTime() && now.getTime() < Date.parse(c.ends_at);
}

export async function recordCampaignEvent(id: string, kind: "impression" | "click", customerId: string | null, itemId: string | null): Promise<void> {
  const { error } = await db().from("campaign_events").insert({ campaign_id: id, kind, customer_id: customerId, menu_item_id: itemId });
  if (error) throw error;
}
