/**
 * The Manager app's marketing contract (Phase 7 plan, "API contract"):
 * shapes, query and body parsing, and the RPC error → HTTP answer map. Pure:
 * exercised offline by scripts/qa/manager-marketing.ts.
 *
 * Kinds: 0064 stores featured / banner / discount_offer / festival_campaign /
 * sponsored_product / other; the contract (and campaigns) say featured_store
 * and seasonal for the first and fourth. Translated here, nowhere else.
 */
import { decodeCursor, encodeCursor } from "@/lib/ops/order-query";
import { campaignEditable, campaignState, validateCampaignInput, type CampaignInput, type CampaignKind,
  type CampaignState, type BannerFields } from "@/lib/marketing/campaign-rules";
import { isUuid } from "@/lib/auth/manager-scope";
import type { OpsResult } from "@/lib/ops/order-actions";

export interface Ref { id: string; name: string }

export type RequestType = "featured_store" | "banner" | "seasonal" | "sponsored_product" | "discount_offer" | "other";
export type RequestStatus = "pending" | "approved" | "rejected" | "in_progress" | "completed" | "cancelled";
export const REQUEST_TYPES: readonly RequestType[] = ["featured_store", "banner", "seasonal", "sponsored_product", "discount_offer", "other"];
export const REQUEST_STATUSES: readonly RequestStatus[] = ["pending", "approved", "rejected", "in_progress", "completed", "cancelled"];

const TO_DB: Record<RequestType, string> = {
  featured_store: "featured", banner: "banner", seasonal: "festival_campaign",
  sponsored_product: "sponsored_product", discount_offer: "discount_offer", other: "other",
};
const FROM_DB: Record<string, RequestType> = Object.fromEntries(Object.entries(TO_DB).map(([k, v]) => [v, k as RequestType]));
export const dbKind = (t: RequestType) => TO_DB[t];
export const requestType = (dbValue: string): RequestType => FROM_DB[dbValue] ?? "other";
/** The campaign a request type becomes, or null (discount_offer, other). */
export function campaignKindFor(t: RequestType): CampaignKind | null {
  return t === "discount_offer" || t === "other" ? null : t;
}

export interface MarketingRequest {
  id: string;
  number: number;
  vendor: Ref;
  zone: Ref | null;
  source: "vendor" | "ops";
  type: RequestType;
  title: string;
  details: string;
  preferredStart: string | null;
  preferredEnd: string | null;
  budget: number | null;
  items: Ref[];
  proposedOffer: Record<string, unknown> | null;
  attachmentUrl: string | null;
  status: RequestStatus;
  remarks: string | null;
  requestedBy: { id: string; name: string; role: "restaurant" | "manager" | "admin" };
  decidedBy: Ref | null;
  decidedAt: string | null;
  campaignId: string | null;
  offerCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignHeadline { impressions: number; clicks: number; attributedOrders: number; attributedSales: number }

export interface CampaignSummary {
  id: string;
  kind: CampaignKind;
  title: string;
  zone: Ref;
  vendors: Ref[];
  status: "approved" | "in_progress" | "completed" | "cancelled";
  state: CampaignState;
  startsAt: string;
  endsAt: string;
  budget: number | null;
  fundedBy: "vendor" | "deligro" | "shared";
  vendorSharePct: number | null;
  slotPosition: number | null;
  offerCode: string | null;
  requestId: string | null;
  headline: CampaignHeadline;
}

export interface CampaignDetail extends CampaignSummary {
  items: Ref[];
  banner: BannerFields | null;
  notes: string | null;
  createdBy: Ref;
  createdAt: string;
  updatedAt: string;
  cancelledReason: string | null;
  allowed: { edit: boolean; editWindowOnly: boolean; cancel: boolean; endNow: boolean; uploadImage: boolean };
}

// ── row → contract ───────────────────────────────────────────────────────

export interface RequestRow {
  id: string; number: number; restaurant_id: string; zone_id: string | null; source: string | null; kind: string;
  title: string; details: string | null; starts_on: string | null; ends_on: string | null; budget: number | null;
  menu_item_ids: string[] | null; proposed_offer: Record<string, unknown> | null; attachment_path: string | null;
  status: string; admin_remarks: string | null; requested_by: string; decided_by: string | null; decided_at: string | null;
  campaign_id: string | null; offer_code: string | null; created_at: string; updated_at: string;
}

export interface Names {
  shop: (id: string) => string;
  zone: (id: string | null) => Ref | null;
  person: (id: string) => { name: string; role: string };
  item: (id: string) => string;
}

export function serializeRequest(r: RequestRow, names: Names, attachmentUrl: string | null = null): MarketingRequest {
  const by = names.person(r.requested_by);
  const role = by.role === "admin" ? "admin" : by.role === "manager" ? "manager" : "restaurant";
  return {
    id: r.id,
    number: Number(r.number),
    vendor: { id: r.restaurant_id, name: names.shop(r.restaurant_id) },
    zone: names.zone(r.zone_id),
    source: r.source === "ops" ? "ops" : "vendor",
    type: requestType(r.kind),
    title: r.title,
    details: r.details ?? "",
    preferredStart: r.starts_on,
    preferredEnd: r.ends_on,
    budget: r.budget == null ? null : Number(r.budget),
    items: (r.menu_item_ids ?? []).map((id) => ({ id, name: names.item(id) })),
    proposedOffer: r.proposed_offer ?? null,
    attachmentUrl,
    status: (REQUEST_STATUSES as readonly string[]).includes(r.status) ? (r.status as RequestStatus) : "pending",
    remarks: r.admin_remarks,
    requestedBy: { id: r.requested_by, name: by.name, role },
    decidedBy: r.decided_by ? { id: r.decided_by, name: names.person(r.decided_by).name } : null,
    decidedAt: r.decided_at,
    campaignId: r.campaign_id,
    offerCode: r.offer_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CampaignRow {
  id: string; kind: CampaignKind; title: string; zone_id: string; restaurant_id: string | null; status: CampaignSummary["status"];
  starts_at: string; ends_at: string; budget: number | null; funded_by: CampaignSummary["fundedBy"]; vendor_share_pct: number | null;
  slot_position: number | null; banner_id: string | null; offer_code: string | null; request_id: string | null; notes: string | null;
  created_by: string; cancelled_reason: string | null; created_at: string; updated_at: string;
}

const ZERO: CampaignHeadline = { impressions: 0, clicks: 0, attributedOrders: 0, attributedSales: 0 };

export function serializeCampaign(c: CampaignRow, vendorIds: string[], names: Names, now: Date, headline: CampaignHeadline = ZERO): CampaignSummary {
  const iso = (t: string) => new Date(t).toISOString();
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    zone: names.zone(c.zone_id) ?? { id: c.zone_id, name: "Zone" },
    vendors: vendorIds.map((id) => ({ id, name: names.shop(id) })),
    status: c.status,
    state: campaignState({ status: c.status, startsAt: c.starts_at, endsAt: c.ends_at }, now),
    startsAt: iso(c.starts_at),
    endsAt: iso(c.ends_at),
    budget: c.budget == null ? null : Number(c.budget),
    fundedBy: c.funded_by,
    vendorSharePct: c.vendor_share_pct,
    slotPosition: c.slot_position,
    offerCode: c.offer_code,
    requestId: c.request_id,
    headline,
  };
}

export function serializeCampaignDetail(
  c: CampaignRow, vendorIds: string[], itemIds: string[], banner: BannerFields | null, names: Names, now: Date, headline: CampaignHeadline,
): CampaignDetail {
  return {
    ...serializeCampaign(c, vendorIds, names, now, headline),
    items: itemIds.map((id) => ({ id, name: names.item(id) })),
    banner,
    notes: c.notes,
    createdBy: { id: c.created_by, name: names.person(c.created_by).name },
    createdAt: new Date(c.created_at).toISOString(),
    updatedAt: new Date(c.updated_at).toISOString(),
    cancelledReason: c.cancelled_reason,
    allowed: campaignEditable({ kind: c.kind, status: c.status, startsAt: c.starts_at, endsAt: c.ends_at }, now),
  };
}

// ── queries ──────────────────────────────────────────────────────────────

type Bad = { ok: false; field: string };
const limitOf = (raw: string | null): number | null => {
  if (raw === null || raw === "") return 50;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
};

export interface RequestQuery {
  status: RequestStatus | null; type: RequestType | null; vendorId: string | null; zoneId: string | null;
  cursor: { createdAt: string; id: string } | null; limit: number;
}

export function parseRequestQuery(p: URLSearchParams): { ok: true; q: RequestQuery } | Bad {
  const status = p.get("status");
  if (status && !(REQUEST_STATUSES as readonly string[]).includes(status)) return { ok: false, field: "status" };
  const type = p.get("type");
  if (type && !(REQUEST_TYPES as readonly string[]).includes(type)) return { ok: false, field: "type" };
  const vendor = p.get("vendor");
  if (vendor && !isUuid(vendor)) return { ok: false, field: "vendor" };
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };
  const rawCursor = p.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return { ok: false, field: "cursor" };
  const limit = limitOf(p.get("limit"));
  if (limit === null) return { ok: false, field: "limit" };
  return { ok: true, q: { status: (status as RequestStatus) || null, type: (type as RequestType) || null,
    vendorId: vendor?.toLowerCase() ?? null, zoneId: zone?.toLowerCase() ?? null, cursor, limit } };
}

export const CAMPAIGN_STATES = ["scheduled", "active", "expired", "all"] as const;
export interface CampaignQuery {
  state: (typeof CAMPAIGN_STATES)[number]; kind: CampaignKind | null; vendorId: string | null; zoneId: string | null;
  cursor: { createdAt: string; id: string } | null; limit: number;
}

export function parseCampaignQuery(p: URLSearchParams): { ok: true; q: CampaignQuery } | Bad {
  const state = p.get("state") ?? "all";
  if (!(CAMPAIGN_STATES as readonly string[]).includes(state)) return { ok: false, field: "state" };
  const kind = p.get("kind");
  if (kind && !["featured_store", "banner", "seasonal", "sponsored_product"].includes(kind)) return { ok: false, field: "kind" };
  const vendor = p.get("vendor");
  if (vendor && !isUuid(vendor)) return { ok: false, field: "vendor" };
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };
  const rawCursor = p.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return { ok: false, field: "cursor" };
  const limit = limitOf(p.get("limit"));
  if (limit === null) return { ok: false, field: "limit" };
  return { ok: true, q: { state: state as CampaignQuery["state"], kind: (kind as CampaignKind) || null,
    vendorId: vendor?.toLowerCase() ?? null, zoneId: zone?.toLowerCase() ?? null, cursor, limit } };
}

export const nextCursor = (rows: { created_at: string; id: string }[], limit: number): string | null =>
  rows.length > limit ? encodeCursor(new Date(rows[limit - 1].created_at).toISOString(), rows[limit - 1].id) : null;

// ── bodies ───────────────────────────────────────────────────────────────

const clientId = (v: unknown): string | null => (typeof v === "string" && v.length >= 8 && v.length <= 80 ? v : null);
const text = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : null;
};
const dateKey = (v: unknown): string | null | undefined =>
  v === null || v === undefined || v === "" ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

export interface CreateRequestBody {
  vendorId: string; type: RequestType; title: string; details: string; preferredStart: string | null; preferredEnd: string | null;
  budget: number | null; itemIds: string[]; proposedOffer: Record<string, unknown> | null; clientActionId: string;
}

export function parseCreateRequestBody(b: Record<string, unknown> | null): { ok: true; body: CreateRequestBody } | Bad {
  if (!b) return { ok: false, field: "body" };
  if (!isUuid(b.vendorId)) return { ok: false, field: "vendorId" };
  if (!(REQUEST_TYPES as readonly unknown[]).includes(b.type)) return { ok: false, field: "type" };
  const title = text(b.title, 3, 120);
  if (!title) return { ok: false, field: "title" };
  const details = b.details == null ? "" : typeof b.details === "string" && b.details.length <= 2000 ? b.details : null;
  if (details === null) return { ok: false, field: "details" };
  const ps = dateKey(b.preferredStart), pe = dateKey(b.preferredEnd);
  if (ps === undefined) return { ok: false, field: "preferredStart" };
  if (pe === undefined || (ps && pe && pe < ps)) return { ok: false, field: "preferredEnd" };
  const budget = b.budget == null ? null : typeof b.budget === "number" && Number.isInteger(b.budget) && b.budget >= 0 && b.budget <= 10_000_000 ? b.budget : undefined;
  if (budget === undefined) return { ok: false, field: "budget" };
  const items = b.itemIds == null ? [] : Array.isArray(b.itemIds) && b.itemIds.length <= 20 && b.itemIds.every(isUuid) ? (b.itemIds as string[]) : null;
  if (!items) return { ok: false, field: "itemIds" };
  const offer = b.proposedOffer == null ? null : typeof b.proposedOffer === "object" && !Array.isArray(b.proposedOffer) ? (b.proposedOffer as Record<string, unknown>) : undefined;
  if (offer === undefined || (offer && b.type !== "discount_offer")) return { ok: false, field: "proposedOffer" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, body: { vendorId: (b.vendorId as string).toLowerCase(), type: b.type as RequestType, title, details,
    preferredStart: ps, preferredEnd: pe, budget, itemIds: items, proposedOffer: offer, clientActionId: cid } };
}

export interface DecideBody {
  decision: "approve" | "reject"; expected: string; remarks: string | null;
  campaign: Record<string, unknown> | null; offer: Record<string, unknown> | null; clientActionId: string;
}

/** `type` is the request's; approving a campaign type needs `campaign`, a discount offer needs `offer`. */
export function parseDecideBody(b: Record<string, unknown> | null, type: RequestType, now: Date):
  { ok: true; body: DecideBody } | { ok: false; field: string; error?: string } {
  if (!b) return { ok: false, field: "body" };
  if (b.decision !== "approve" && b.decision !== "reject") return { ok: false, field: "decision" };
  if (typeof b.expected !== "string") return { ok: false, field: "expected" };
  const remarks = b.remarks == null || b.remarks === "" ? null : text(b.remarks, 1, 1000);
  if (b.remarks != null && b.remarks !== "" && remarks === null) return { ok: false, field: "remarks" };
  if (b.decision === "reject" && (!remarks || remarks.length < 3)) return { ok: false, field: "remarks", error: "reason_required" };
  let campaign: Record<string, unknown> | null = null;
  let offer: Record<string, unknown> | null = null;
  if (b.decision === "approve") {
    const kind = campaignKindFor(type);
    if (kind) {
      if (!b.campaign || typeof b.campaign !== "object") return { ok: false, field: "campaign" };
      // Kind, zone, vendor and request come from the request itself (0160).
      const probe = validateCampaignInput({ ...(b.campaign as object), kind, zoneId: "00000000-0000-0000-0000-000000000001",
        vendorIds: kind === "seasonal" ? (b.campaign as { vendorIds?: unknown }).vendorIds ?? [] : ["00000000-0000-0000-0000-000000000001"] }, now);
      if (!probe.ok && !["zoneId", "vendorIds"].includes(probe.field)) return { ok: false, field: `campaign.${probe.field}` };
      campaign = b.campaign as Record<string, unknown>;
    } else if (type === "discount_offer") {
      if (!b.offer || typeof b.offer !== "object") return { ok: false, field: "offer" };
      offer = b.offer as Record<string, unknown>;
    }
  }
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, body: { decision: b.decision, expected: b.expected, remarks, campaign, offer, clientActionId: cid } };
}

export function parseProgressBody(b: Record<string, unknown> | null): { ok: true; status: "in_progress" | "completed"; remarks: string | null; clientActionId: string } | Bad {
  if (!b) return { ok: false, field: "body" };
  if (b.status !== "in_progress" && b.status !== "completed") return { ok: false, field: "status" };
  const remarks = b.remarks == null || b.remarks === "" ? null : text(b.remarks, 1, 1000);
  if (b.remarks != null && b.remarks !== "" && remarks === null) return { ok: false, field: "remarks" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, status: b.status, remarks, clientActionId: cid };
}

export function parseCreateCampaignBody(b: Record<string, unknown> | null, now: Date): { ok: true; input: CampaignInput; clientActionId: string } | Bad {
  if (!b) return { ok: false, field: "body" };
  const v = validateCampaignInput(b, now);
  if (!v.ok) return v;
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, input: v.value, clientActionId: cid };
}

export function parseCampaignUpdateBody(b: Record<string, unknown> | null):
  { ok: true; expectedUpdatedAt: string; changes: Record<string, unknown>; reason: string | null; clientActionId: string } | Bad {
  if (!b) return { ok: false, field: "body" };
  if (typeof b.expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(b.expectedUpdatedAt))) return { ok: false, field: "expectedUpdatedAt" };
  if (!b.changes || typeof b.changes !== "object" || Array.isArray(b.changes) || Object.keys(b.changes).length === 0) return { ok: false, field: "changes" };
  const reason = b.reason == null || b.reason === "" ? null : text(b.reason, 3, 300);
  if (b.reason != null && b.reason !== "" && reason === null) return { ok: false, field: "reason" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, expectedUpdatedAt: b.expectedUpdatedAt, changes: b.changes as Record<string, unknown>, reason, clientActionId: cid };
}

export function parseCampaignActionBody(b: Record<string, unknown> | null):
  { ok: true; action: "cancel" | "end_now"; reason: string; clientActionId: string } | { ok: false; field: string; error?: string } {
  if (!b) return { ok: false, field: "body" };
  if (b.action !== "cancel" && b.action !== "end_now") return { ok: false, field: "action" };
  const reason = text(b.reason, 3, 300);
  if (!reason) return { ok: false, field: "reason", error: "reason_required" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, action: b.action, reason, clientActionId: cid };
}

// ── RPC errors ───────────────────────────────────────────────────────────

const CONFLICT = new Set(["stale", "slot_taken", "code_taken", "consent_required", "out_of_scope", "platform_wide_admin_only",
  "locked_field", "invalid_transition", "expired", "exhausted", "not_a_customer"]);

/** A Phase 7 RPC's raised error → the pinned answer. Messages are checked before codes. */
export function mapMarketingRpcError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  const detail = e.details ?? null;
  if (message === "reason_required") return { ok: false, status: 400, error: "reason_required", extra: { httpStatus: 422 } };
  if (message === "bad_request") return { ok: false, status: 400, error: "bad_request", extra: detail ? { field: detail } : undefined };
  if (message === "client_action_id_conflict") return { ok: false, status: 409, error: "stale" };
  if (message === "slot_taken") return { ok: false, status: 409, error: "slot_taken", extra: detail ? { campaignId: detail } : undefined };
  if (message === "stale") return { ok: false, status: 409, error: "stale", extra: detail ? { current: detail } : undefined };
  if (message === "out_of_scope" || message === "locked_field") {
    return { ok: false, status: 409, error: message, extra: detail ? { field: detail } : undefined };
  }
  if (CONFLICT.has(message)) return { ok: false, status: 409, error: message };
  if (message === "forbidden" || e.code === "42501") return { ok: false, status: 404, error: "not_found" };
  return { ok: false, status: 500, error: "action_failed" };
}

/** The HTTP status to answer with (reason_required is 422 in Phase 7's contract). */
export function httpStatusOf(r: Extract<OpsResult, { ok: false }>): number {
  return (r.extra?.httpStatus as number | undefined) ?? r.status;
}

/** The body to answer with (without the internal httpStatus hint). */
export function errorBody(r: Extract<OpsResult, { ok: false }>): Record<string, unknown> {
  const { httpStatus: _drop, ...extra } = r.extra ?? {};
  void _drop;
  return { error: r.error, ...extra };
}
