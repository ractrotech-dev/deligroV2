/**
 * Bodies of the vendor action, onboarding, document upload and ticket routes,
 * the permission each needs, and how a vendor RPC's error becomes the pinned
 * HTTP answer. Pure.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { mapRpcError, type OpsResult } from "./order-actions";
import { DOC_TYPES, VENDOR_STATUSES, type DocType } from "./vendor-contract";
import type { VendorAction, VendorStatus } from "./vendor-rules";

export type VendorActionName = VendorAction | "verify_document" | "reject_document";

/** The switch each vendor action needs (plan, Global Constraints). */
export const VENDOR_ACTION_PERMISSION: Record<VendorActionName, string> = {
  approve: "manager.vendors.status",
  reject: "manager.vendors.status",
  suspend: "manager.vendors.status",
  reactivate: "manager.vendors.status",
  verify_document: "manager.vendors.status",
  reject_document: "manager.vendors.status",
};

export const TICKET_MESSAGE_PERMISSION = "manager.support.manage";

export type ParsedVendorAction =
  | { action: VendorAction; expected: VendorStatus; reason: string; override: boolean; clientActionId: string }
  | { action: "verify_document"; documentId: string; reason: string | null; clientActionId: string }
  | { action: "reject_document"; documentId: string; reason: string; clientActionId: string };

type Fail = { ok: false; status: 400; error: "bad_request" | "reason_required"; field?: string };
const bad = (field: string): Fail => ({ ok: false, status: 400, error: "bad_request", field });
const needReason: Fail = { ok: false, status: 400, error: "reason_required" };

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const reasonOf = (v: unknown, min = 3, max = 300): string | null => {
  const t = text(v);
  return t && t.length >= min && t.length <= max ? t : null;
};

export function parseVendorActionBody(body: Record<string, unknown> | null): { ok: true; action: ParsedVendorAction } | Fail {
  if (!body) return bad("body");
  const action = body.action;
  if (typeof action !== "string" || !(action in VENDOR_ACTION_PERMISSION)) return bad("action");
  const clientActionId = body.clientActionId;
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) return bad("clientActionId");

  if (action === "verify_document" || action === "reject_document") {
    if (typeof body.documentId !== "string" || !isUuid(body.documentId)) return bad("documentId");
    if (action === "reject_document") {
      const reason = reasonOf(body.reason, 3, 500);
      if (!reason) return needReason;
      return { ok: true, action: { action, documentId: body.documentId.toLowerCase(), reason, clientActionId } };
    }
    // Verifying takes an optional `note`; `reason` is accepted from older clients.
    const note = text(body.note ?? body.reason);
    if (note && note.length > 500) return needReason;
    return { ok: true, action: { action, documentId: body.documentId.toLowerCase(), reason: note, clientActionId } };
  }

  const expected = body.expected;
  if (typeof expected !== "string" || !VENDOR_STATUSES.includes(expected as VendorStatus)) return bad("expected");
  if (body.override !== undefined && typeof body.override !== "boolean") return bad("override");
  const reason = reasonOf(body.reason);
  if (!reason) return needReason;
  return {
    ok: true,
    action: { action: action as VendorAction, expected: expected as VendorStatus, reason, override: body.override === true, clientActionId },
  };
}

/** A vendor RPC's error → the pinned answer (Phase 3's mapping plus the vendor codes). */
export function mapVendorRpcError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  if (message === "needs_map_pin") return { ok: false, status: 409, error: "needs_map_pin" };
  if (message === "documents_unverified") {
    const missing = (e.details ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { ok: false, status: 409, error: "documents_unverified", extra: { missing } };
  }
  return mapRpcError(e);
}

// ── onboarding ───────────────────────────────────────────────────────────────

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A public object in the vendor-logos bucket, named as uploadVendorLogo names it. */
const LOGO_URL = /^https:\/\/[^/\s]+\/storage\/v1\/object\/public\/vendor-logos\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** The logo URL is in this project's own bucket (the parser checks the shape; this the host). */
export function isOwnLogoUrl(url: string, supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl || !LOGO_URL.test(url)) return false;
  return url.startsWith(`${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/vendor-logos/`);
}

/** Onboarding fields a manager may send. Money terms and bank details are not among them. */
export interface OnboardInput {
  clientActionId: string;
  zoneId: string;
  shopName: string;
  category: string | null;
  description: string | null;
  ownerName: string;
  mobile: string;
  /** Second contact number, as the registration wizard collects (restaurants.owner_alt_mobile). */
  altMobile: string | null;
  email: string;
  password: string | null;
  /** A logo uploaded through POST /api/manager/vendors/logo (the vendor-logos bucket). */
  logoUrl: string | null;
  address: string;
  landmark: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  openingTime: string | null;
  closingTime: string | null;
  weeklyOff: string[];
  deliveryAvailable: boolean;
  selfPickup: boolean;
  fssaiNumber: string | null;
}

export function parseOnboardBody(body: Record<string, unknown> | null): { ok: true; input: OnboardInput } | { ok: false; field: string } {
  if (!body) return { ok: false, field: "body" };
  const f = (field: string) => ({ ok: false as const, field });
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return f("clientActionId");
  if (typeof body.zoneId !== "string" || !isUuid(body.zoneId)) return f("zoneId");
  const shopName = text(body.shopName);
  if (!shopName || shopName.length < 2 || shopName.length > 80) return f("shopName");
  const ownerName = text(body.ownerName);
  if (!ownerName || ownerName.length > 80) return f("ownerName");
  const mobile = typeof body.mobile === "string" ? body.mobile.replace(/\D/g, "") : "";
  if (!/^[6-9]\d{9}$/.test(mobile)) return f("mobile");
  let altMobile: string | null = null;
  if (body.altMobile !== undefined && body.altMobile !== null && body.altMobile !== "") {
    altMobile = typeof body.altMobile === "string" ? body.altMobile.replace(/\D/g, "") : "";
    if (!/^[6-9]\d{9}$/.test(altMobile) || altMobile === mobile) return f("altMobile");
  }
  let logoUrl: string | null = null;
  if (body.logoUrl !== undefined && body.logoUrl !== null && body.logoUrl !== "") {
    if (typeof body.logoUrl !== "string" || !LOGO_URL.test(body.logoUrl)) return f("logoUrl");
    logoUrl = body.logoUrl;
  }
  const email = text(body.email)?.toLowerCase() ?? "";
  if (!EMAIL.test(email) || email.length > 120) return f("email");
  const password = body.password === undefined || body.password === null ? null : body.password;
  if (password !== null && (typeof password !== "string" || password.length < 8 || password.length > 72)) return f("password");
  const address = text(body.address);
  if (!address || address.length > 300) return f("address");
  const optional = (k: string, max: number) => {
    const v = body[k];
    if (v === undefined || v === null || v === "") return { ok: true as const, v: null };
    if (typeof v !== "string" || v.trim().length > max) return { ok: false as const };
    return { ok: true as const, v: v.trim() };
  };
  const fields: Record<string, string | null> = {};
  for (const [k, max] of [["category", 60], ["description", 500], ["landmark", 120], ["pincode", 10], ["fssaiNumber", 30]] as const) {
    const r = optional(k, max);
    if (!r.ok) return f(k);
    fields[k] = r.v;
  }
  if (fields.pincode && !/^\d{6}$/.test(fields.pincode)) return f("pincode");
  const coord = (k: "lat" | "lng", lim: number) => {
    const v = body[k];
    if (v === undefined || v === null) return { ok: true as const, v: null };
    return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim ? { ok: true as const, v } : { ok: false as const };
  };
  const lat = coord("lat", 90);
  if (!lat.ok) return f("lat");
  const lng = coord("lng", 180);
  if (!lng.ok) return f("lng");
  if ((lat.v === null) !== (lng.v === null)) return f(lat.v === null ? "lat" : "lng");
  const time = (k: "openingTime" | "closingTime") => {
    const v = body[k];
    if (v === undefined || v === null || v === "") return { ok: true as const, v: null };
    return typeof v === "string" && TIME.test(v) ? { ok: true as const, v } : { ok: false as const };
  };
  const opening = time("openingTime");
  if (!opening.ok) return f("openingTime");
  const closing = time("closingTime");
  if (!closing.ok) return f("closingTime");
  const weeklyOffRaw = body.weeklyOff ?? [];
  if (!Array.isArray(weeklyOffRaw) || weeklyOffRaw.some((d) => typeof d !== "string" || !WEEKDAYS.includes(d.toLowerCase()))) {
    return f("weeklyOff");
  }
  for (const k of ["deliveryAvailable", "selfPickup"] as const) {
    if (body[k] !== undefined && typeof body[k] !== "boolean") return f(k);
  }
  return {
    ok: true,
    input: {
      clientActionId: body.clientActionId.toLowerCase(),
      zoneId: body.zoneId.toLowerCase(),
      shopName,
      category: fields.category,
      description: fields.description,
      ownerName,
      mobile,
      altMobile,
      email,
      password: password as string | null,
      logoUrl,
      address,
      landmark: fields.landmark,
      pincode: fields.pincode,
      lat: lat.v,
      lng: lng.v,
      openingTime: opening.v,
      closingTime: closing.v,
      // Stored as the database's day names ("Monday"), which restaurant_status_now compares.
      weeklyOff: [...new Set((weeklyOffRaw as string[]).map((d) => d[0].toUpperCase() + d.slice(1).toLowerCase()))],
      deliveryAvailable: body.deliveryAvailable !== false,
      selfPickup: body.selfPickup === true,
      fssaiNumber: fields.fssaiNumber,
    },
  };
}

// ── uploads ──────────────────────────────────────────────────────────────────

export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * A declared body far over the limit, refused before `formData()` buffers it
 * (the post-read size check stays). Multipart framing gets 64 KB of slack; a
 * missing or junk header is left to the post-read check.
 */
export function uploadTooLarge(contentLength: string | null, max = UPLOAD_MAX_BYTES): boolean {
  const n = Number(contentLength);
  return contentLength !== null && contentLength.trim() !== "" && Number.isFinite(n) && n > max + 64 * 1024;
}

/** Null when acceptable; the byte signature is checked again when stored. */
export function checkUpload(docType: string, mime: string, size: number): "bad_file" | null {
  if (!DOC_TYPES.includes(docType as DocType)) return "bad_file";
  if (!UPLOAD_TYPES.includes(mime)) return "bad_file";
  if (!Number.isFinite(size) || size <= 0 || size > UPLOAD_MAX_BYTES) return "bad_file";
  return null;
}

// ── tickets ──────────────────────────────────────────────────────────────────

export function parseTicketMessageBody(
  body: Record<string, unknown> | null
): { ok: true; message: { body: string; internal: boolean; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  if (body.internal !== undefined && typeof body.internal !== "boolean") return bad("internal");
  const msg = reasonOf(body.body, 1, 4000);
  if (!msg) return needReason;
  return { ok: true, message: { body: msg, internal: body.internal === true, clientActionId: body.clientActionId } };
}

export const MANAGER_TICKET_STATUSES = ["in_progress", "waiting_on_requester", "resolved", "closed"] as const;

export function parseTicketStatusBody(
  body: Record<string, unknown> | null
): { ok: true; status: { status: (typeof MANAGER_TICKET_STATUSES)[number]; resolution: string | null; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  const status = body.status;
  if (typeof status !== "string" || !MANAGER_TICKET_STATUSES.includes(status as (typeof MANAGER_TICKET_STATUSES)[number])) {
    return bad("status");
  }
  const closing = status === "resolved" || status === "closed";
  const resolution = reasonOf(body.resolution, 3, 1000);
  if (closing && !resolution) return needReason;
  return {
    ok: true,
    status: { status: status as (typeof MANAGER_TICKET_STATUSES)[number], resolution: closing ? resolution : null, clientActionId: body.clientActionId },
  };
}
