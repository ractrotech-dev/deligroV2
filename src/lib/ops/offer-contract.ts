/**
 * The Manager app's offers contract (Phase 7 plan, "Offers"): shapes, row
 * serialisers, query and body parsing. Pure; exercised by
 * scripts/qa/manager-offers.ts.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { OFFER_STATES, offerState, validateOfferTerms, type OfferState, type OfferTerms, type OfferUsage as UsageFigures } from "@/lib/ops/offer-rules";
import type { Ref } from "@/lib/ops/marketing-contract";

/** The contract's usage: per vendor by name, never per customer. */
export type OfferUsage = Omit<UsageFigures, "byVendor"> & {
  byVendor: { vendor: Ref; redemptions: number; discountGiven: number }[];
};

export interface OfferSummary {
  code: string;
  label: string | null;
  kind: "percent" | "flat";
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  state: OfferState;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  fundedBy: "platform" | "vendor";
  vendors: Ref[];
  zones: Ref[];
  itemCount: number;
  redemptions: number;
  maxRedemptions: number | null;
  discountGiven: number;
  createdBy: Ref | null;
  updatedAt: string;
}

export interface OfferDetail extends OfferSummary {
  maxPerCustomer: number | null;
  items: Ref[];
  requestId: string | null;
  campaignIds: string[];
  allowed: { edit: boolean; activate: boolean; deactivate: boolean };
}

export interface OfferChange {
  id: string;
  at: string;
  actor: { id: string; name: string; role: "admin" | "manager" | "restaurant" | "system" } | null;
  op: "insert" | "update" | "delete";
  target: "coupon" | "vendor" | "zone" | "item";
  fields: { field: string; before: string | null; after: string | null }[];
  reason: string | null;
}

/** A row of 0164's ops_offer_rows. */
export interface OfferRow {
  code: string; label: string | null; kind: "percent" | "flat"; value: number | string; min_order: number | string;
  max_discount: number | string | null; active: boolean; starts_at: string | null; expires_at: string | null;
  max_per_customer: number | null; max_redemptions: number | null; funded_by: "platform" | "vendor"; created_by: string | null;
  created_at: string; updated_at: string; vendor_ids: string[]; zone_ids: string[]; item_ids: string[];
  platform_wide: boolean; in_scope: boolean; redemptions: number; discount_given: number;
}

export interface OfferNames {
  shop: (id: string) => string;
  zone: (id: string) => string;
  person: (id: string) => string;
  item: (id: string) => string;
}

const n = (v: number | string | null) => (v === null ? null : Number(v));
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export function offerStateOf(r: OfferRow, now: Date): OfferState {
  return offerState({ active: r.active, startsAt: r.starts_at, expiresAt: r.expires_at, maxRedemptions: r.max_redemptions,
    redemptions: r.redemptions }, now);
}

export function serializeOffer(r: OfferRow, names: OfferNames, now: Date): OfferSummary {
  return {
    code: r.code,
    label: r.label,
    kind: r.kind,
    value: Number(r.value),
    minOrder: Number(r.min_order),
    maxDiscount: n(r.max_discount),
    state: offerStateOf(r, now),
    active: r.active,
    startsAt: iso(r.starts_at),
    expiresAt: iso(r.expires_at),
    fundedBy: r.funded_by,
    vendors: r.vendor_ids.map((id) => ({ id, name: names.shop(id) })),
    zones: r.zone_ids.map((id) => ({ id, name: names.zone(id) })),
    itemCount: r.item_ids.length,
    redemptions: r.redemptions,
    maxRedemptions: r.max_redemptions,
    discountGiven: r.discount_given,
    createdBy: r.created_by ? { id: r.created_by, name: names.person(r.created_by) } : null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * What a manager may do with an offer. Platform-wide codes, and codes that
 * reach beyond their zones, are read-only to managers; admins may do anything.
 */
export function offerAllowed(r: OfferRow, now: Date, admin: boolean): OfferDetail["allowed"] {
  const mine = admin || (!r.platform_wide && r.in_scope);
  // Checked directly: a switched-off code reads "inactive" before "expired" or
  // "exhausted", but switching it on is refused for either (0161).
  const ended = !!r.expires_at && Date.parse(r.expires_at) <= now.getTime();
  const usedUp = r.max_redemptions !== null && r.redemptions >= r.max_redemptions;
  return {
    edit: mine,
    activate: mine && !r.active && !ended && !usedUp,
    deactivate: mine && r.active,
  };
}

export function serializeOfferDetail(
  r: OfferRow, names: OfferNames, now: Date, admin: boolean, requestId: string | null, campaignIds: string[],
): OfferDetail {
  return {
    ...serializeOffer(r, names, now),
    maxPerCustomer: r.max_per_customer,
    items: r.item_ids.map((id) => ({ id, name: names.item(id) })),
    requestId,
    campaignIds,
    allowed: offerAllowed(r, now, admin),
  };
}

const SKIP = new Set(["code", "created_by"]);
const show = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
const CAMEL: Record<string, string> = {
  min_order: "minOrder", max_discount: "maxDiscount", starts_at: "startsAt", expires_at: "expiresAt", max_per_customer: "maxPerCustomer",
  max_redemptions: "maxRedemptions", funded_by: "fundedBy", restaurant_id: "vendorId", zone_id: "zoneId", menu_item_id: "itemId",
};

/** A coupon_changes row → the contract's field diff. */
export function serializeChange(
  row: { id: number | string; created_at: string; actor_id: string | null; op: OfferChange["op"]; target: OfferChange["target"];
    before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null },
  person: (id: string) => { name: string; role: string },
): OfferChange {
  const keys = new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})]);
  const fields: OfferChange["fields"] = [];
  for (const k of [...keys].sort()) {
    if (SKIP.has(k)) continue;
    const b = show(row.before?.[k]), a = show(row.after?.[k]);
    if (b === a) continue;
    fields.push({ field: CAMEL[k] ?? k, before: b, after: a });
  }
  let actor: OfferChange["actor"] = null;
  if (row.actor_id) {
    const p = person(row.actor_id);
    const role = p.role === "admin" || p.role === "manager" ? p.role : p.role === "restaurant" ? "restaurant" : "system";
    actor = { id: row.actor_id, name: p.name, role };
  }
  return { id: String(row.id), at: new Date(row.created_at).toISOString(), actor, op: row.op, target: row.target, fields, reason: row.reason };
}

// ── queries and bodies ───────────────────────────────────────────────────

export const OFFER_LIST_STATES = [...OFFER_STATES, "all"] as const;

export interface OfferQuery {
  state: (typeof OFFER_LIST_STATES)[number]; vendorId: string | null; zoneId: string | null; q: string | null;
  cursor: { updatedAt: string; code: string } | null; limit: number;
}

export function encodeOfferCursor(updatedAt: string, code: string): string {
  return Buffer.from(`${updatedAt}|${code}`, "utf8").toString("base64url");
}

function decodeOfferCursor(s: string): { updatedAt: string; code: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const updatedAt = raw.slice(0, bar), code = raw.slice(bar + 1);
  return Number.isNaN(Date.parse(updatedAt)) || !/^[A-Z0-9]{3,20}$/.test(code) ? null : { updatedAt, code };
}

export function parseOfferQuery(p: URLSearchParams): { ok: true; q: OfferQuery } | { ok: false; field: string } {
  const state = p.get("state") ?? "all";
  if (!(OFFER_LIST_STATES as readonly string[]).includes(state)) return { ok: false, field: "state" };
  const vendor = p.get("vendor");
  if (vendor && !isUuid(vendor)) return { ok: false, field: "vendor" };
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };
  const q = p.get("q")?.trim() || null;
  if (q && q.length > 40) return { ok: false, field: "q" };
  const raw = p.get("cursor");
  const cursor = raw ? decodeOfferCursor(raw) : null;
  if (raw && !cursor) return { ok: false, field: "cursor" };
  const rawLimit = p.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, field: "limit" };
  return { ok: true, q: { state: state as OfferQuery["state"], vendorId: vendor?.toLowerCase() ?? null, zoneId: zone?.toLowerCase() ?? null,
    q, cursor, limit } };
}

const clientId = (v: unknown): string | null => (typeof v === "string" && v.length >= 8 && v.length <= 80 ? v : null);

/** POST /offers: the full terms. Managers must set an end. */
export function parseCreateOfferBody(b: Record<string, unknown> | null, now: Date, admin: boolean):
  { ok: true; terms: OfferTerms; clientActionId: string } | { ok: false; field: string } {
  if (!b) return { ok: false, field: "body" };
  const v = validateOfferTerms(b, now, { requireExpiry: !admin });
  if (!v.ok) return v;
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  const t = v.value;
  return { ok: true, clientActionId: cid, terms: {
    code: t.code!, label: t.label ?? null, kind: t.kind ?? "flat", value: t.value ?? 0, minOrder: t.minOrder ?? 0,
    maxDiscount: t.maxDiscount ?? null, startsAt: t.startsAt ?? null, expiresAt: t.expiresAt ?? null,
    maxPerCustomer: t.maxPerCustomer ?? null, maxRedemptions: t.maxRedemptions ?? null, vendorIds: t.vendorIds ?? [],
    zoneIds: t.zoneIds ?? [], itemIds: t.itemIds ?? [], fundedBy: t.fundedBy ?? "platform", requestId: t.requestId ?? null } };
}

/** PATCH /offers/[code]: some terms, a token and a reason. */
export function parseUpdateOfferBody(b: Record<string, unknown> | null, now: Date):
  { ok: true; changes: Partial<OfferTerms>; expectedUpdatedAt: string; reason: string; clientActionId: string } | { ok: false; field: string; error?: string } {
  if (!b) return { ok: false, field: "body" };
  if (typeof b.expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(b.expectedUpdatedAt))) return { ok: false, field: "expectedUpdatedAt" };
  if (!b.changes || typeof b.changes !== "object" || Array.isArray(b.changes)) return { ok: false, field: "changes" };
  const v = validateOfferTerms(b.changes, now, { partial: true });
  if (!v.ok) return v;
  if (Object.keys(v.value).length === 0) return { ok: false, field: "changes" };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300) return { ok: false, field: "reason", error: "reason_required" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, changes: v.value, expectedUpdatedAt: b.expectedUpdatedAt, reason, clientActionId: cid };
}

export function parseOfferActionBody(b: Record<string, unknown> | null):
  { ok: true; action: "activate" | "deactivate"; reason: string; clientActionId: string } | { ok: false; field: string; error?: string } {
  if (!b) return { ok: false, field: "body" };
  if (b.action !== "activate" && b.action !== "deactivate") return { ok: false, field: "action" };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300) return { ok: false, field: "reason", error: "reason_required" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, action: b.action, reason, clientActionId: cid };
}

/** Terms (camelCase) → the jsonb ops_upsert_offer reads. */
export function termsJson(t: Partial<OfferTerms>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) if (v !== undefined) out[k] = v;
  return out;
}
