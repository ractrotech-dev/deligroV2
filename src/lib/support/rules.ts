import { isPlausibleFix } from "@/lib/geo/fix";

/**
 * Support tickets, SOS and announcements as pure rules: which categories a
 * rider may pick and in what order (§13.3), what priority each starts at,
 * what an SOS kind files as, and the parsers every route and admin action
 * runs first. No I/O, so the QA script runs them bare and the data layer
 * (`data-access/support.ts`, `sos.ts`, `announcements.ts`) asks them before
 * writing. The database has the last word on the hard limits (0087: 4000
 * characters, 4 attachments, the priority and status lists).
 */

/** The rider's Help list, in the order of §13.3. */
export const RIDER_TICKET_CATEGORIES = [
  "vendor_not_handing_over",
  "customer_unreachable",
  "incorrect_address",
  "delivery_payment",
  "cash_reconciliation",
  "accident_emergency",
  "app_technical",
  "other",
] as const;

/** The Safety screen's report forms (§15). Every one is an emergency. */
export const SAFETY_CATEGORIES = [
  "unsafe_situation",
  "accident",
  "vehicle_breakdown",
  "harassment_threat",
  "suspicious_order_location",
] as const;

/**
 * Pickup reports raised from the job screen (Phase 2's exception sheet). The
 * server files these as tickets itself (ruling P2-R11); a rider does not pick
 * them in Help.
 */
export const PICKUP_REPORT_CATEGORIES = ["missing_items", "wrong_package", "vendor_delay", "other_issue"] as const;

/** What the SOS route accepts: the big button, or one of the report forms. */
export const SOS_KINDS = ["alert", ...SAFETY_CATEGORIES] as const;

export const TICKET_PRIORITIES = ["normal", "high", "emergency"] as const;
/** 0064's list plus 0143's `escalated`. */
export const TICKET_STATUSES = ["open", "in_progress", "waiting_on_requester", "escalated", "resolved", "closed"] as const;
export const TICKET_ROLES = ["rider", "vendor", "customer", "manager"] as const;
export const ANNOUNCEMENT_AUDIENCES = ["rider", "vendor", "manager", "all"] as const;

export type RiderTicketCategory = (typeof RIDER_TICKET_CATEGORIES)[number];
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];
export type SosKind = (typeof SOS_KINDS)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_TYPES = ["image/jpeg", "image/png"] as const;
export const MESSAGE_MAX = 4000;
export const SUBJECT_MAX = 120;
export const SOS_NOTE_MAX = 500;
/** SOS taps within this many minutes of the last one join the same ticket (0087 `rider_raise_sos`). */
export const SOS_DEDUPE_MINUTES = 10;

const LABELS: Record<string, string> = {
  vendor_not_handing_over: "Shop not handing over the order",
  customer_unreachable: "Customer unreachable",
  incorrect_address: "Incorrect address",
  delivery_payment: "Delivery payment issue",
  cash_reconciliation: "Cash reconciliation",
  accident_emergency: "Accident or emergency",
  app_technical: "App or technical problem",
  other: "Something else",
  unsafe_situation: "Unsafe situation",
  accident: "Accident",
  vehicle_breakdown: "Vehicle breakdown",
  harassment_threat: "Harassment or threats",
  suspicious_order_location: "Suspicious order or location",
  missing_items: "Missing items",
  wrong_package: "Wrong package",
  vendor_delay: "Shop delay",
  other_issue: "Other pickup issue",
  order_issue: "Order issue",
  alert: "SOS",
};

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_requester: "Waiting for your reply",
  escalated: "Escalated",
  resolved: "Resolved",
  closed: "Closed",
};

/** "Shop delay", "App or technical problem"; an unknown key reads as words. */
export function categoryLabel(category: string): string {
  const known = LABELS[category];
  if (known) return known;
  const words = category.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : category;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as TicketStatus] ?? categoryLabel(status);
}

const has = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export const isTicketStatus = (v: unknown): v is TicketStatus => has(TICKET_STATUSES, v);
export const isTicketPriority = (v: unknown): v is TicketPriority => has(TICKET_PRIORITIES, v);
export const isSafetyCategory = (v: unknown): v is SafetyCategory => has(SAFETY_CATEGORIES, v);
export const isSosKind = (v: unknown): v is SosKind => has(SOS_KINDS, v);

/** What a rider may pick: the eight Help categories and the five safety reports. */
export function isRiderSelectableCategory(v: unknown): v is RiderTicketCategory | SafetyCategory {
  return has(RIDER_TICKET_CATEGORIES, v) || has(SAFETY_CATEGORIES, v);
}

/** `accident_emergency` and every safety report are emergencies; pickup reports are high. */
export function defaultPriority(category: string): TicketPriority {
  if (category === "accident_emergency" || has(SAFETY_CATEGORIES, category)) return "emergency";
  if (has(PICKUP_REPORT_CATEGORIES, category)) return "high";
  return "normal";
}

/** The ticket category an SOS kind is filed under. */
export function sosCategory(kind: SosKind): string {
  return kind === "alert" ? "accident_emergency" : kind;
}

/** A Google Maps link to the point, or null without a usable position. */
export function locationLink(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://maps.google.com/?q=${lat},${lng}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Control characters (not newline/tab) out; trimmed. */
function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
}

/** A position kept only when plausible; anything else is "no position", never an error. */
function position(lat: unknown, lng: unknown): { lat: number | null; lng: number | null } {
  const toNum = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
  const a = toNum(lat);
  const b = toNum(lng);
  return isPlausibleFix(a, b) ? { lat: a as number, lng: b as number } : { lat: null, lng: null };
}

type Fail<E extends string> = { ok: false; error: E };

export interface NewTicket {
  category: RiderTicketCategory | SafetyCategory;
  subject: string;
  message: string;
  orderId: string | null;
  lat: number | null;
  lng: number | null;
}

/** A rider's new ticket, from the route's fields. */
export function parseNewTicket(raw: {
  category?: unknown;
  subject?: unknown;
  message?: unknown;
  orderId?: unknown;
  lat?: unknown;
  lng?: unknown;
}): { ok: true; value: NewTicket } | Fail<"invalid_category" | "invalid_subject" | "invalid_message" | "invalid_order"> {
  if (!isRiderSelectableCategory(raw.category)) return { ok: false, error: "invalid_category" };
  const message = clean(raw.message);
  if (!message || Array.from(message).length > MESSAGE_MAX) return { ok: false, error: "invalid_message" };
  let subject = categoryLabel(raw.category);
  if (raw.subject !== undefined && raw.subject !== null && raw.subject !== "") {
    const s = clean(raw.subject);
    if (s === null || Array.from(s).length > SUBJECT_MAX) return { ok: false, error: "invalid_subject" };
    if (s) subject = s;
  }
  let orderId: string | null = null;
  if (raw.orderId !== undefined && raw.orderId !== null && raw.orderId !== "") {
    if (!isUuid(raw.orderId)) return { ok: false, error: "invalid_order" };
    orderId = raw.orderId;
  }
  return { ok: true, value: { category: raw.category, subject, message, orderId, ...position(raw.lat, raw.lng) } };
}

/** A reply from the requester. */
export function parseMessage(raw: unknown): { ok: true; value: string } | Fail<"invalid_message"> {
  const message = clean(raw);
  if (!message || Array.from(message).length > MESSAGE_MAX) return { ok: false, error: "invalid_message" };
  return { ok: true, value: message };
}

export type AttachmentError = "too_many_photos" | "photo_too_large" | "bad_photo_type";

/**
 * Up to four JPEG/PNG photos of at most 5 MB each — by the declared type and
 * size; the bytes are checked again (magic numbers) before upload.
 */
export function checkAttachments(files: readonly { size: number; type: string }[]): AttachmentError | null {
  if (files.length > MAX_ATTACHMENTS) return "too_many_photos";
  for (const f of files) {
    if (!has(ATTACHMENT_TYPES, f.type) || f.size <= 0) return "bad_photo_type";
    if (f.size > MAX_ATTACHMENT_BYTES) return "photo_too_large";
  }
  return null;
}

export interface SosInput {
  kind: SosKind;
  lat: number | null;
  lng: number | null;
  note: string | null;
  orderId: string | null;
}

/**
 * An SOS. Deliberately forgiving: a bad position or order id is dropped, not
 * refused — the alert matters more than its details. Only an unknown kind (an
 * app bug) or an oversized note is an error.
 */
export function parseSos(raw: {
  kind?: unknown;
  lat?: unknown;
  lng?: unknown;
  note?: unknown;
  orderId?: unknown;
}): { ok: true; value: SosInput } | Fail<"invalid_kind" | "invalid_note"> {
  if (!isSosKind(raw.kind)) return { ok: false, error: "invalid_kind" };
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    const n = clean(raw.note);
    if (n === null || Array.from(n).length > SOS_NOTE_MAX) return { ok: false, error: "invalid_note" };
    note = n || null;
  }
  return {
    ok: true,
    value: { kind: raw.kind, note, orderId: isUuid(raw.orderId) ? raw.orderId : null, ...position(raw.lat, raw.lng) },
  };
}

/** A staff reply (public or an internal note), optionally moving the status on. */
export function parseStaffReply(raw: {
  body?: unknown;
  internal?: unknown;
  status?: unknown;
}): { ok: true; value: { body: string; internal: boolean; status: TicketStatus | null } } | Fail<"invalid_body" | "invalid_status"> {
  const body = clean(raw.body);
  if (!body || Array.from(body).length > MESSAGE_MAX) return { ok: false, error: "invalid_body" };
  let status: TicketStatus | null = null;
  if (raw.status !== undefined && raw.status !== null && raw.status !== "") {
    if (!isTicketStatus(raw.status)) return { ok: false, error: "invalid_status" };
    status = raw.status;
  }
  return { ok: true, value: { body, internal: raw.internal === true || raw.internal === "on", status } };
}

export interface TicketFilter {
  role?: (typeof TICKET_ROLES)[number];
  category?: string;
  priority?: TicketPriority;
  status?: TicketStatus;
}

/** The support desk's filters from a query string; anything unknown is dropped. */
export function parseTicketFilter(sp: Record<string, unknown>): TicketFilter {
  const out: TicketFilter = {};
  if (has(TICKET_ROLES, sp.role)) out.role = sp.role;
  if (typeof sp.category === "string" && /^[a-z_]{2,40}$/.test(sp.category)) out.category = sp.category;
  if (isTicketPriority(sp.priority)) out.priority = sp.priority;
  if (isTicketStatus(sp.status)) out.status = sp.status;
  return out;
}

export interface AnnouncementInput {
  audience: AnnouncementAudience;
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  push: boolean;
}

/** An announcement from the composer. English only (owner decision). */
export function parseAnnouncement(raw: {
  audience?: unknown;
  title?: unknown;
  body?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  push?: unknown;
}): { ok: true; value: AnnouncementInput } | Fail<"invalid_audience" | "invalid_title" | "invalid_body" | "invalid_dates"> {
  if (!has(ANNOUNCEMENT_AUDIENCES, raw.audience)) return { ok: false, error: "invalid_audience" };
  const title = clean(raw.title);
  if (!title || title.length < 3 || title.length > 120) return { ok: false, error: "invalid_title" };
  const body = clean(raw.body);
  if (!body || body.length > 2000) return { ok: false, error: "invalid_body" };
  const when = (v: unknown): string | null | false => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string") return false;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : false;
  };
  const startsAt = when(raw.startsAt);
  const endsAt = when(raw.endsAt);
  if (startsAt === false || endsAt === false) return { ok: false, error: "invalid_dates" };
  if (endsAt && Date.parse(endsAt) <= (startsAt ? Date.parse(startsAt) : Date.now())) {
    return { ok: false, error: "invalid_dates" };
  }
  return { ok: true, value: { audience: raw.audience, title, body, startsAt, endsAt, push: raw.push === true || raw.push === "on" } };
}
