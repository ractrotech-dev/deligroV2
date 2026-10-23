/**
 * Request bodies for the Partner app's growth and support routes (offers,
 * marketing requests, support tickets) and the admin screens that answer them.
 * Pure; tested by scripts/qa/vendor-growth.ts. Every body is untrusted: typed,
 * bounded, trimmed.
 */
import { normalizeCode, type PromotionDraft } from "@/lib/promotion-rules";

type Fail = { error: string };
const fail = (error: string): Fail => ({ error });
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, min: number, max: number): string | null =>
  typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : null;
const intIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isDay = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const isIso = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

// ---- Offers ----------------------------------------------------------------

/**
 * A vendor's own promo code from JSON. The shop and who pays are not the
 * body's to choose: `restaurantId` is the session's shop and `fundedBy` is
 * always the vendor (0041's policies enforce the same).
 */
export function parseOfferBody(body: unknown, restaurantId: string): PromotionDraft | Fail {
  if (!isObj(body)) return fail("bad_request");
  const kind = body.kind === "flat" ? "flat" : body.kind === "percent" ? "percent" : null;
  if (!kind) return fail("invalid_kind");
  const num = (k: string) => (body[k] === null || body[k] === undefined ? null : body[k]);
  for (const k of ["value", "minOrder"] as const) if (!intIn(body[k] ?? 0, 0, 100_000)) return fail(`invalid_${k}`);
  for (const k of ["maxDiscount", "maxPerCustomer", "maxRedemptions"] as const) {
    if (num(k) !== null && !intIn(num(k), 0, 1_000_000)) return fail(`invalid_${k}`);
  }
  for (const k of ["startsAt", "expiresAt"] as const) if (num(k) !== null && !isIso(num(k))) return fail(`invalid_${k}`);
  const label = body.label === undefined || body.label === null ? null : text(body.label, 0, 60);
  if (label === null && body.label) return fail("invalid_label");
  return {
    code: normalizeCode(typeof body.code === "string" ? body.code : ""),
    label: label || null,
    kind,
    value: body.value as number,
    minOrder: (body.minOrder as number | undefined) ?? 0,
    maxDiscount: kind === "percent" ? (num("maxDiscount") as number | null) : null,
    active: body.active !== false,
    startsAt: num("startsAt") === null ? null : new Date(body.startsAt as string).toISOString(),
    expiresAt: num("expiresAt") === null ? null : new Date(body.expiresAt as string).toISOString(),
    maxPerCustomer: num("maxPerCustomer") as number | null,
    maxRedemptions: num("maxRedemptions") as number | null,
    restaurantId,
    fundedBy: "vendor",
  };
}

// ---- Marketing requests ----------------------------------------------------

/** The client's five request types (requirements §6). */
export const MARKETING_KINDS = ["featured", "banner", "discount_offer", "festival_campaign", "sponsored_product"] as const;
export type MarketingKind = (typeof MARKETING_KINDS)[number];
export const MARKETING_STATUSES = ["pending", "approved", "in_progress", "completed", "rejected", "cancelled"] as const;
export type MarketingStatus = (typeof MARKETING_STATUSES)[number];

export interface MarketingRequestInput {
  kind: MarketingKind;
  title: string;
  details: string;
  budget: number | null;
  startsOn: string | null;
  endsOn: string | null;
}

export function parseMarketingRequest(body: unknown, today: string): MarketingRequestInput | Fail {
  if (!isObj(body)) return fail("bad_request");
  if (!(MARKETING_KINDS as readonly string[]).includes(body.kind as string)) return fail("invalid_kind");
  const title = text(body.title, 3, 120);
  if (!title) return fail("invalid_title");
  const details = text(body.details, 10, 2000);
  if (!details) return fail("invalid_details");
  const budget = body.budget === undefined || body.budget === null ? null : body.budget;
  if (budget !== null && !intIn(budget, 0, 10_000_000)) return fail("invalid_budget");
  const startsOn = body.startsOn ?? null, endsOn = body.endsOn ?? null;
  if (startsOn !== null && !isDay(startsOn)) return fail("invalid_dates");
  if (endsOn !== null && !isDay(endsOn)) return fail("invalid_dates");
  if (startsOn && endsOn && endsOn < startsOn) return fail("invalid_dates");
  if (startsOn && startsOn < today) return fail("in_the_past");
  return {
    kind: body.kind as MarketingKind,
    title,
    details,
    budget: budget as number | null,
    startsOn: startsOn as string | null,
    endsOn: endsOn as string | null,
  };
}

/** Which way an admin may move a request from where it is. */
// The audited path's moves (0160): a pending request is approved or rejected;
// one without a campaign then goes in progress and completes by hand (one with
// a campaign follows the campaign's window, or a cancel sends it to rejected).
const NEXT: Record<MarketingStatus, MarketingStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["in_progress"],
  in_progress: ["completed"],
  completed: [],
  rejected: [],
  cancelled: [],
};

export function canMoveMarketing(from: MarketingStatus, to: MarketingStatus): boolean {
  return NEXT[from].includes(to);
}

export function parseMarketingDecision(body: unknown): { status: MarketingStatus; remarks: string | null } | Fail {
  if (!isObj(body)) return fail("bad_request");
  if (!(MARKETING_STATUSES as readonly string[]).includes(body.status as string) || body.status === "pending" || body.status === "cancelled") {
    return fail("invalid_status");
  }
  const remarks = body.remarks === undefined || body.remarks === null || body.remarks === "" ? null : text(body.remarks, 1, 1000);
  if (remarks === null && body.remarks) return fail("invalid_remarks");
  // A rejection always says why.
  if (body.status === "rejected" && !remarks) return fail("remarks_required");
  return { status: body.status as MarketingStatus, remarks };
}

// ---- Support tickets -------------------------------------------------------

/** The client's issue categories (requirements §12). */
export const VENDOR_TICKET_CATEGORIES = ["payments", "commission", "orders", "refunds", "products", "technical", "other"] as const;
export const TICKET_STATUSES = ["open", "in_progress", "waiting_on_requester", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attachment paths a requester may cite: files they uploaded to their own folder. */
export function validAttachments(v: unknown, ownerId: string): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 4) return null;
  const re = new RegExp(`^${ownerId}/[0-9a-f-]{36}\\.(jpg|png)$`);
  return v.every((p) => typeof p === "string" && re.test(p)) ? (v as string[]) : null;
}

export interface TicketInput {
  category: string;
  subject: string;
  body: string;
  orderId: string | null;
  attachments: string[];
}

export function parseTicket(body: unknown, requesterId: string): TicketInput | Fail {
  if (!isObj(body)) return fail("bad_request");
  if (!(VENDOR_TICKET_CATEGORIES as readonly string[]).includes(body.category as string)) return fail("invalid_category");
  const subject = text(body.subject, 3, 120);
  if (!subject) return fail("invalid_subject");
  const message = text(body.body, 1, 4000);
  if (!message) return fail("invalid_body");
  const orderId = body.orderId === undefined || body.orderId === null ? null : body.orderId;
  if (orderId !== null && !(typeof orderId === "string" && UUID.test(orderId))) return fail("invalid_order");
  const attachments = validAttachments(body.attachments, requesterId);
  if (!attachments) return fail("invalid_attachments");
  return { category: body.category as string, subject, body: message, orderId: orderId as string | null, attachments };
}

export function parseTicketMessage(
  body: unknown,
  authorId: string,
  opts: { allowInternal?: boolean } = {}
): { body: string; attachments: string[]; internal: boolean } | Fail {
  if (!isObj(body)) return fail("bad_request");
  const message = text(body.body, 1, 4000);
  if (!message) return fail("invalid_body");
  const attachments = validAttachments(body.attachments, authorId);
  if (!attachments) return fail("invalid_attachments");
  const internal = opts.allowInternal ? body.internal === true : false;
  return { body: message, attachments, internal };
}

// ---- Announcements ---------------------------------------------------------

export const ANNOUNCEMENT_AUDIENCES = ["vendor", "rider", "manager", "all"] as const;

export function parseAnnouncement(body: unknown): {
  audience: (typeof ANNOUNCEMENT_AUDIENCES)[number];
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  push: boolean;
} | Fail {
  if (!isObj(body)) return fail("bad_request");
  if (!(ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(body.audience as string)) return fail("invalid_audience");
  const title = text(body.title, 3, 120);
  if (!title) return fail("invalid_title");
  const message = text(body.body, 1, 2000);
  if (!message) return fail("invalid_body");
  const startsAt = body.startsAt ? body.startsAt : null;
  const endsAt = body.endsAt ? body.endsAt : null;
  if (startsAt !== null && !isIso(startsAt)) return fail("invalid_dates");
  if (endsAt !== null && !isIso(endsAt)) return fail("invalid_dates");
  if (startsAt && endsAt && Date.parse(endsAt as string) <= Date.parse(startsAt as string)) return fail("invalid_dates");
  return {
    audience: body.audience as (typeof ANNOUNCEMENT_AUDIENCES)[number],
    title,
    body: message,
    startsAt: startsAt === null ? null : new Date(startsAt as string).toISOString(),
    endsAt: endsAt === null ? null : new Date(endsAt as string).toISOString(),
    push: body.push !== false,
  };
}
