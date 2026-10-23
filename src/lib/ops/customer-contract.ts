/**
 * The Manager app's customers contract (Phase 7 plan, "Customers"): shapes,
 * row serialisers, query and body parsing. Pure; exercised by
 * scripts/qa/manager-customers.ts.
 *
 * Personal data: a payload carries a display name ("Priya S."), a masked
 * phone and localities — never a phone, email, address line or position.
 * The only exception is the contact-reveal answer, which is audited.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { maskPhone } from "@/lib/ops/offer-rules";
import type { Ref } from "@/lib/ops/marketing-contract";

export type AccountStatus = "active" | "suspended" | "restricted";
export const ACCOUNT_STATUSES: readonly AccountStatus[] = ["active", "suspended", "restricted"];

export interface CustomerSummary {
  id: string;
  shortId: string;
  name: string | null;
  phoneMasked: string | null;
  status: AccountStatus;
  memberSince: string;
  orders: number;
  spent: number;
  lastOrderAt: string | null;
  zones: Ref[];
}

export interface CustomerDetail extends CustomerSummary {
  statusReason: string | null;
  statusChangedAt: string | null;
  statusChangedBy: Ref | null;
  localities: string[];
  cancelledOrders: number;
  aov: number;
  firstOrderAt: string | null;
  ratingsGiven: number;
  avgRatingGiven: number | null;
  openComplaints: number;
  pendingRefunds: number;
  allowed: { revealContact: boolean; suspend: boolean; restrict: boolean; reactivate: boolean; decideRefunds: boolean };
}

/** "Priya Sharma" → "Priya S."; one word stays as it is. */
export function displayName(full: string | null | undefined): string | null {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** The last two comma parts of an address line ("…, Station Road, Bemetara"). */
export function localityOf(line: string): string | null {
  const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(-2).join(", ");
}

export const shortIdOf = (id: string) => id.replace(/-/g, "").slice(0, 8);

const status = (s: string | null | undefined): AccountStatus =>
  (ACCOUNT_STATUSES as readonly string[]).includes(s ?? "") ? (s as AccountStatus) : "active";

/** A row of 0162's ops_customer_list. */
export interface CustomerListRow {
  id: string; full_name: string | null; phone: string | null; account_status: string; member_since: string;
  orders: number; spent: number; last_order_at: string | null; zone_ids: string[] | null; sort_key: string;
}

export function serializeCustomer(r: CustomerListRow, zoneName: (id: string) => string): CustomerSummary {
  return {
    id: r.id,
    shortId: shortIdOf(r.id),
    name: displayName(r.full_name),
    phoneMasked: maskPhone(r.phone),
    status: status(r.account_status),
    memberSince: new Date(r.member_since).toISOString(),
    orders: Number(r.orders),
    spent: Number(r.spent),
    lastOrderAt: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
    zones: (r.zone_ids ?? []).map((id) => ({ id, name: zoneName(id) })),
  };
}

/** What this manager may do with this customer (their switches, the account's state). */
export function customerAllowed(s: AccountStatus, permissions: Record<string, boolean>): CustomerDetail["allowed"] {
  const suspend = permissions["manager.customers.suspend"] === true;
  return {
    revealContact: permissions["manager.customers.contact"] === true,
    suspend: suspend && s !== "suspended",
    restrict: suspend && s !== "restricted",
    reactivate: suspend && s !== "active",
    decideRefunds: permissions["manager.finance.view"] === true && permissions["manager.finance.adjust"] === true,
  };
}

// ── queries and bodies ───────────────────────────────────────────────────

export const CUSTOMER_SORTS = ["recent", "orders", "spend"] as const;
export interface CustomerQuery {
  q: string | null; phone: string | null; status: AccountStatus | null; zoneId: string | null;
  sort: (typeof CUSTOMER_SORTS)[number]; cursor: { key: string; id: string } | null; limit: number;
}

export function encodeCustomerCursor(key: string, id: string): string {
  return Buffer.from(`${key}|${id}`, "utf8").toString("base64url");
}

function decodeCustomerCursor(s: string): { key: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const key = raw.slice(0, bar), id = raw.slice(bar + 1);
  return /^[0-9]{1,20}$/.test(key) && isUuid(id) ? { key, id } : null;
}

/** "9876543210" or "+919876543210" → "+919876543210"; anything else null. */
export function phoneE164(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, "");
  if (/^\d{10}$/.test(d)) return `+91${d}`;
  if (/^\+91\d{10}$/.test(d)) return d;
  return null;
}

export function parseCustomerQuery(p: URLSearchParams): { ok: true; q: CustomerQuery } | { ok: false; field: string } {
  const q = p.get("q")?.trim() || null;
  if (q !== null && (q.length < 2 || q.length > 60)) return { ok: false, field: "q" };
  const rawPhone = p.get("phone")?.trim() || null;
  const phone = rawPhone ? phoneE164(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, field: "phone" };
  const st = p.get("status");
  if (st && !(ACCOUNT_STATUSES as readonly string[]).includes(st)) return { ok: false, field: "status" };
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };
  const sort = p.get("sort") ?? "recent";
  if (!(CUSTOMER_SORTS as readonly string[]).includes(sort)) return { ok: false, field: "sort" };
  const raw = p.get("cursor");
  const cursor = raw ? decodeCustomerCursor(raw) : null;
  if (raw && !cursor) return { ok: false, field: "cursor" };
  const rawLimit = p.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, field: "limit" };
  // String(q): isUuid is a type guard, and narrowing q would make the else branch never.
  const normQ = q !== null && isUuid(String(q)) ? q.toLowerCase() : q;
  return { ok: true, q: { q: normQ, phone, status: (st as AccountStatus) || null,
    zoneId: zone?.toLowerCase() ?? null, sort: sort as CustomerQuery["sort"], cursor, limit } };
}

const clientId = (v: unknown): string | null => (typeof v === "string" && v.length >= 8 && v.length <= 80 ? v : null);
export const CONTACT_REASONS = ["order_issue", "refund", "complaint", "delivery", "other"] as const;

export function parseContactBody(b: Record<string, unknown> | null):
  { ok: true; reason: (typeof CONTACT_REASONS)[number]; note: string | null; clientActionId: string } | { ok: false; field: string; error?: string } {
  if (!b) return { ok: false, field: "body" };
  if (!(CONTACT_REASONS as readonly unknown[]).includes(b.reason)) return { ok: false, field: "reason", error: "reason_required" };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (b.reason === "other" && (note.length < 3 || note.length > 200)) return { ok: false, field: "note", error: "reason_required" };
  if (note.length > 200) return { ok: false, field: "note" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, reason: b.reason as (typeof CONTACT_REASONS)[number], note: note || null, clientActionId: cid };
}

export function parseAccountActionBody(b: Record<string, unknown> | null):
  { ok: true; action: "suspend" | "restrict" | "reactivate"; expected: AccountStatus; reason: string; clientActionId: string }
  | { ok: false; field: string; error?: string } {
  if (!b) return { ok: false, field: "body" };
  if (b.action !== "suspend" && b.action !== "restrict" && b.action !== "reactivate") return { ok: false, field: "action" };
  if (!(ACCOUNT_STATUSES as readonly unknown[]).includes(b.expected)) return { ok: false, field: "expected" };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300) return { ok: false, field: "reason", error: "reason_required" };
  const cid = clientId(b.clientActionId);
  if (!cid) return { ok: false, field: "clientActionId" };
  return { ok: true, action: b.action, expected: b.expected as AccountStatus, reason, clientActionId: cid };
}
