/**
 * The Manager app's vendor, review, document and ticket shapes (Phase 4 plan,
 * "API contract"), the vendor list query, and the serialisers that turn
 * database rows into them. Pure: no I/O.
 *
 * What never leaves the server through these: bank details, PAN, GST, UPI,
 * vendor login credentials, and customer phone numbers (reviews carry a first
 * name only). The finance block is omitted — the key absent — without
 * manager.finance.view.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { orderShortCode } from "./order-contract";
import type { AllowedVendorActions, VendorStatus } from "./vendor-rules";

export const VENDOR_STATUSES: readonly VendorStatus[] = ["pending", "active", "inactive", "suspended", "rejected"];
export const VENDOR_FILTERS = ["active", "online", "pending", "needs_attention"] as const;
export type VendorFilter = (typeof VENDOR_FILTERS)[number];

export const OPEN_STATES = ["open", "closed", "temporarily_closed", "holiday", "weekly_off", "outside_hours"] as const;
export type OpenState = (typeof OPEN_STATES)[number];

export type DocType = "fssai" | "gst" | "pan" | "bank_proof" | "shop_license" | "other";
export const DOC_TYPES: readonly DocType[] = ["fssai", "gst", "pan", "bank_proof", "shop_license", "other"];

export type TicketStatus = "open" | "in_progress" | "waiting_on_requester" | "escalated" | "resolved" | "closed";
/** Statuses that count as an open complaint. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = ["open", "in_progress", "waiting_on_requester", "escalated"];

export interface PersonRef { id: string; name: string }

export interface VendorListItem {
  id: string;
  name: string;
  slug: string;
  status: VendorStatus;
  openState: OpenState;
  category: string | null;
  zone: { id: string; name: string };
  logoUrl: string | null;
  rating: number;
  ratingCount: number;
  todayOrders: number;
  pendingDocuments: number;
  openComplaints: number;
  createdAt: string;
}

export interface VendorCounts {
  all: number;
  pending: number;
  active: number;
  suspended: number;
  rejected: number;
  inactive: number;
  online: number;
}

export interface VendorDocumentItem {
  id: string;
  type: DocType;
  fileName: string;
  status: "pending" | "verified" | "rejected";
  remarks: string | null;
  reviewedBy: PersonRef | null;
  reviewedAt: string | null;
  uploadedAt: string;
}

export interface ReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  customerFirstName: string | null;
  createdAt: string;
  status: "published" | "hidden" | "removed";
  orderCode: string | null;
  subRatings: { foodQuality: number | null; packaging: number | null; deliveryExperience: number | null; valueForMoney: number | null };
  reply: { text: string; at: string } | null;
}

export interface TicketSummary {
  id: string;
  number: number;
  subject: string;
  category: string;
  priority: "normal" | "high" | "emergency";
  status: TicketStatus;
  requesterRole: string;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VendorPerformance {
  from: string;
  to: string;
  orders: number;
  sales: number;
  aov: number;
  cancellationRate: number;
  rejectionRate: number;
  avgAcceptMinutes: number | null;
  avgPrepMinutes: number | null;
  rating: number;
  ratingCount: number;
  ratingDistribution: Record<"1" | "2" | "3" | "4" | "5", number>;
}

export interface VendorSettlementItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  netPayable: number;
  status: "draft" | "paid" | "void";
  paidAt: string | null;
  paymentRef: string | null;
}

export interface VendorFinance {
  commissionPct: number;
  commissionGstPct: number;
  otherChargesPerOrder: number;
  settlementCycle: string | null;
  pendingPayment: number;
  recoverable: number;
  commissionThisPeriod: number;
  settlements: VendorSettlementItem[];
}

/** The list item, with `openComplaints` as the latest open tickets rather than their count. */
export interface VendorDetail extends Omit<VendorListItem, "openComplaints"> {
  statusReason: string | null;
  statusChangedAt: string | null;
  statusChangedBy: PersonRef | null;
  description: string | null;
  contact: { shopPhone: string | null; ownerName: string | null; ownerMobile: string | null; ownerEmail: string | null };
  address: { line: string | null; landmark: string | null; pincode: string | null; lat: number | null; lng: number | null };
  hours: {
    opening: string | null;
    closing: string | null;
    weeklyOff: string[];
    closedUntil: string | null;
    holidays: { from: string; to: string; note: string | null }[];
    deliveryAvailable: boolean;
    selfPickup: boolean;
    prepMinutesDefault: number | null;
  };
  registration: { fssaiNumber: string | null; tcAcceptedAt: string | null; tcVersion: string | null; onboardedAt: string };
  documents: VendorDocumentItem[];
  performance: VendorPerformance;
  finance?: VendorFinance;
  openComplaints: TicketSummary[];
  allowed: AllowedVendorActions;
}

// ── query ────────────────────────────────────────────────────────────────────

export interface VendorQuery {
  q: string | null;
  statuses: VendorStatus[];
  filter: VendorFilter | null;
  zone: string | null;
  category: string | null;
  cursor: { name: string; id: string } | null;
  limit: number;
}

export const VENDOR_DEFAULT_LIMIT = 50;
export const VENDOR_MAX_LIMIT = 100;

export function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id]), "utf8").toString("base64url");
}

export function decodeNameCursor(s: string): { name: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || !isUuid(v[1])) return null;
    return { name: v[0], id: v[1] };
  } catch {
    return null;
  }
}

export function parseLimit(raw: string | null, def = VENDOR_DEFAULT_LIMIT, max = VENDOR_MAX_LIMIT): number | null {
  if (raw === null || raw === "") return def;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

export function parseVendorQuery(params: URLSearchParams): { ok: true; query: VendorQuery } | { ok: false; field: string } {
  const qRaw = (params.get("q") ?? "").trim();
  if (qRaw !== "" && (qRaw.length < 2 || qRaw.length > 80)) return { ok: false, field: "q" };

  const statuses = (params.get("status") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (statuses.some((s) => !VENDOR_STATUSES.includes(s as VendorStatus))) return { ok: false, field: "status" };

  const filterRaw = params.get("filter");
  if (filterRaw && !VENDOR_FILTERS.includes(filterRaw as VendorFilter)) return { ok: false, field: "filter" };

  const zone = params.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };

  const category = (params.get("category") ?? "").trim();
  if (category.length > 60) return { ok: false, field: "category" };

  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw ? decodeNameCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { ok: false, field: "cursor" };

  const limit = parseLimit(params.get("limit"));
  if (limit === null) return { ok: false, field: "limit" };

  return {
    ok: true,
    query: {
      q: qRaw || null,
      statuses: statuses as VendorStatus[],
      filter: (filterRaw as VendorFilter) || null,
      zone: zone ? zone.toLowerCase() : null,
      category: category || null,
      cursor,
      limit,
    },
  };
}

// ── serialisers ──────────────────────────────────────────────────────────────

export function openStateOf(raw: string | null | undefined): OpenState {
  return OPEN_STATES.includes(raw as OpenState) ? (raw as OpenState) : "closed";
}

export function firstName(full: string | null | undefined): string | null {
  const first = (full ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const hhmm = (v: string | null | undefined): string | null => (v ? v.slice(0, 5) : null);

export interface VendorListRow {
  id: string;
  name: string | null;
  slug: string;
  status: string;
  category: string | null;
  zone_id: string;
  zone_name: string | null;
  image_url: string | null;
  rating: number | string | null;
  rating_count: number | null;
  created_at: string;
}

export interface VendorListExtras {
  openState: OpenState;
  todayOrders: number;
  pendingDocuments: number;
  openComplaints: number;
}

export function toVendorListItem(r: VendorListRow, x: VendorListExtras): VendorListItem {
  const rating = num(r.rating);
  return {
    id: r.id,
    name: r.name?.trim() || "Shop",
    slug: r.slug,
    status: (VENDOR_STATUSES.includes(r.status as VendorStatus) ? r.status : "pending") as VendorStatus,
    openState: x.openState,
    category: r.category ?? null,
    zone: { id: r.zone_id, name: r.zone_name?.trim() || "Zone" },
    logoUrl: r.image_url ?? null,
    rating: rating === null ? 0 : Math.round(rating * 10) / 10,
    ratingCount: r.rating_count ?? 0,
    todayOrders: x.todayOrders,
    pendingDocuments: x.pendingDocuments,
    openComplaints: x.openComplaints,
    createdAt: r.created_at,
  };
}

export interface DocumentRow {
  id: string;
  doc_type: string;
  file_name: string;
  status: string | null;
  remarks: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export function toVendorDocument(r: DocumentRow, names: Map<string, string>): VendorDocumentItem {
  const status = r.status === "verified" || r.status === "rejected" ? r.status : "pending";
  return {
    id: r.id,
    type: (DOC_TYPES.includes(r.doc_type as DocType) ? r.doc_type : "other") as DocType,
    fileName: r.file_name,
    status,
    remarks: r.remarks ?? null,
    reviewedBy: r.reviewed_by ? { id: r.reviewed_by, name: names.get(r.reviewed_by) ?? "Staff" } : null,
    reviewedAt: r.reviewed_at ?? null,
    uploadedAt: r.created_at,
  };
}

type One<T> = T | T[] | null | undefined;
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export interface ReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  status: string | null;
  order_id: string | null;
  food_quality: number | null;
  packaging: number | null;
  delivery_experience: number | null;
  value_for_money: number | null;
  profiles: One<{ full_name: string | null; phone?: string | null }>;
  review_replies: One<{ reply_text: string; created_at: string; removed_at: string | null }>;
}

export function toReviewItem(r: ReviewRow): ReviewItem {
  const reply = one(r.review_replies);
  const status = r.status === "published" || r.status === null ? "published" : r.status === "removed" ? "removed" : "hidden";
  return {
    id: r.id,
    rating: r.rating,
    comment: r.comment ?? null,
    customerFirstName: firstName(one(r.profiles)?.full_name),
    createdAt: r.created_at,
    status,
    orderCode: r.order_id ? orderShortCode(r.order_id) : null,
    subRatings: {
      foodQuality: r.food_quality ?? null,
      packaging: r.packaging ?? null,
      deliveryExperience: r.delivery_experience ?? null,
      valueForMoney: r.value_for_money ?? null,
    },
    reply: reply && !reply.removed_at ? { text: reply.reply_text, at: reply.created_at } : null,
  };
}

export interface TicketRow {
  id: string;
  number: number | string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  requester_role: string;
  order_id: string | null;
  created_at: string;
  updated_at: string;
}

export const TICKET_COLUMNS = "id, number, subject, category, priority, status, requester_role, order_id, created_at, updated_at";

/** Stored requester roles ("vendor", "rider") in the contract's words. */
const REQUESTER_ROLE: Record<string, string> = { vendor: "restaurant", rider: "driver" };

export function toTicketSummary(r: TicketRow): TicketSummary {
  return {
    id: r.id,
    number: Number(r.number),
    subject: r.subject,
    category: r.category,
    priority: (["normal", "high", "emergency"].includes(r.priority) ? r.priority : "normal") as TicketSummary["priority"],
    status: r.status as TicketStatus,
    requesterRole: REQUESTER_ROLE[r.requester_role] ?? r.requester_role,
    orderId: r.order_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface VendorDetailRow extends VendorListRow {
  status_reason: string | null;
  status_changed_at: string | null;
  description: string | null;
  shop_phone: string | null;
  owner_name: string | null;
  owner_mobile: string | null;
  owner_email: string | null;
  address: string | null;
  landmark: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  opening_time: string | null;
  closing_time: string | null;
  weekly_off: string[] | null;
  closed_until: string | null;
  delivery_available: boolean | null;
  self_pickup: boolean | null;
  prep_minutes: number | null;
  fssai_number: string | null;
  tc_accepted_at: string | null;
  tc_version: string | null;
}

export interface VendorDetailInput {
  row: VendorDetailRow;
  extras: VendorListExtras;
  statusChangedBy: PersonRef | null;
  documents: VendorDocumentItem[];
  holidays: { starts_on: string; ends_on: string; note: string | null }[];
  performance: VendorPerformance;
  finance: VendorFinance | null;
  openComplaints: TicketSummary[];
  allowed: AllowedVendorActions;
}

/** The detail answer. Built field by field: nothing from the row passes through unnamed. */
export function buildVendorDetail(input: VendorDetailInput, perms: Record<string, boolean>): VendorDetail {
  const r = input.row;
  const pinned = r.lat !== null && r.lng !== null && r.lat !== undefined && r.lng !== undefined;
  const detail: VendorDetail = {
    ...toVendorListItem(r, input.extras),
    statusReason: r.status_reason ?? null,
    statusChangedAt: r.status_changed_at ?? null,
    statusChangedBy: input.statusChangedBy,
    description: r.description ?? null,
    contact: {
      shopPhone: r.shop_phone ?? null,
      ownerName: r.owner_name ?? null,
      ownerMobile: r.owner_mobile ?? null,
      ownerEmail: r.owner_email ?? null,
    },
    address: {
      line: r.address ?? null,
      landmark: r.landmark ?? null,
      pincode: r.pincode ?? null,
      lat: pinned ? Number(r.lat) : null,
      lng: pinned ? Number(r.lng) : null,
    },
    hours: {
      opening: hhmm(r.opening_time),
      closing: hhmm(r.closing_time),
      weeklyOff: (r.weekly_off ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean),
      closedUntil: r.closed_until ?? null,
      holidays: input.holidays.map((h) => ({ from: h.starts_on, to: h.ends_on, note: h.note ?? null })),
      deliveryAvailable: r.delivery_available ?? true,
      selfPickup: r.self_pickup ?? false,
      prepMinutesDefault: r.prep_minutes ?? null,
    },
    registration: {
      fssaiNumber: r.fssai_number ?? null,
      tcAcceptedAt: r.tc_accepted_at ?? null,
      tcVersion: r.tc_version ?? null,
      onboardedAt: r.created_at,
    },
    documents: input.documents,
    performance: input.performance,
    openComplaints: input.openComplaints,
    allowed: input.allowed,
  };
  if (perms["manager.finance.view"] === true && input.finance) detail.finance = input.finance;
  return detail;
}
