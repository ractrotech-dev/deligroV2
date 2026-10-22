/**
 * Bodies of the rider action, onboarding and document-upload routes, the
 * switch each action needs, document-number rules, and how a rider RPC's error
 * becomes the pinned HTTP answer (Phase 5 plan, API contract). Pure.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { phoneToSyntheticEmail, toE164 } from "@/lib/auth/phone";
import { mapRpcError, type OpsResult } from "./order-actions";
import { EXPIRING_RIDER_DOCS, RIDER_DOC_TYPES, type RiderDocType } from "./rider-contract";

export type RiderAction =
  | "approve" | "reject" | "suspend" | "reactivate" | "force_offline"
  | "verify_document" | "reject_document" | "add_adjustment";

/** The switch each rider action needs (plan, Global Constraints). */
export const RIDER_ACTION_PERMISSION: Record<RiderAction, "manager.riders.status" | "manager.finance.adjust"> = {
  approve: "manager.riders.status",
  reject: "manager.riders.status",
  suspend: "manager.riders.status",
  reactivate: "manager.riders.status",
  force_offline: "manager.riders.status",
  verify_document: "manager.riders.status",
  reject_document: "manager.riders.status",
  add_adjustment: "manager.finance.adjust",
};

export type ParsedRiderAction =
  | { action: "approve" | "reject"; expected: "unverified" | "pending" | "rejected"; reason: string; override: boolean; clientActionId: string }
  | { action: "suspend" | "reactivate"; expected: "active" | "suspended"; reason: string; clientActionId: string }
  | { action: "force_offline"; reason: string; clientActionId: string }
  | { action: "verify_document"; documentId: string; remarks: string | null; clientActionId: string }
  | { action: "reject_document"; documentId: string; remarks: string; clientActionId: string }
  | {
      action: "add_adjustment";
      kind: "bonus" | "deduction" | "adjustment";
      amount: number;
      effectiveOn: string;
      orderId: string | null;
      reason: string;
      clientActionId: string;
    };

type Fail = { ok: false; status: 400; error: "bad_request" | "reason_required" | "remarks_required"; field?: string };
const bad = (field: string): Fail => ({ ok: false, status: 400, error: "bad_request", field });

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const between = (v: unknown, min: number, max: number): string | null => {
  const t = text(v);
  return t && t.length >= min && t.length <= max ? t : null;
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (2026-02-30 is not). */
export function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseRiderActionBody(body: Record<string, unknown> | null): { ok: true; action: ParsedRiderAction } | Fail {
  if (!body) return bad("body");
  const action = body.action;
  if (typeof action !== "string" || !(action in RIDER_ACTION_PERMISSION)) return bad("action");
  const clientActionId = body.clientActionId;
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) return bad("clientActionId");

  const act = action as RiderAction;
  switch (act) {
    case "verify_document":
    case "reject_document": {
      if (typeof body.documentId !== "string" || !isUuid(body.documentId)) return bad("documentId");
      const documentId = body.documentId.toLowerCase();
      if (act === "reject_document") {
        const remarks = between(body.remarks ?? body.reason, 3, 500);
        if (!remarks) return { ok: false, status: 400, error: "remarks_required" };
        return { ok: true, action: { action: act, documentId, remarks, clientActionId } };
      }
      const remarks = text(body.remarks);
      if (remarks && remarks.length > 500) return bad("remarks");
      return { ok: true, action: { action: "verify_document", documentId, remarks, clientActionId } };
    }
    case "add_adjustment": {
      const reason = between(body.reason, 3, 300);
      if (!reason) return { ok: false, status: 400, error: "reason_required" };
      const a = body.adjustment as Record<string, unknown> | undefined;
      if (!a || typeof a !== "object") return bad("adjustment");
      const kind = a.kind;
      if (kind !== "bonus" && kind !== "deduction" && kind !== "adjustment") return bad("kind");
      const amount = typeof a.amount === "number" && Number.isFinite(a.amount) ? Math.round(a.amount * 100) / 100 : NaN;
      if (Number.isNaN(amount) || amount === 0 || Math.abs(amount) > 100000 || (kind !== "adjustment" && amount < 0)) return bad("amount");
      if (!isDay(a.effectiveOn)) return bad("effectiveOn");
      const orderId = a.orderId === undefined || a.orderId === null ? null : a.orderId;
      if (orderId !== null && (typeof orderId !== "string" || !isUuid(orderId))) return bad("orderId");
      return { ok: true, action: { action: "add_adjustment", kind, amount, effectiveOn: a.effectiveOn, orderId, reason, clientActionId } };
    }
    case "force_offline": {
      const reason = between(body.reason, 3, 300);
      if (!reason) return { ok: false, status: 400, error: "reason_required" };
      return { ok: true, action: { action: "force_offline", reason, clientActionId } };
    }
    case "approve":
    case "reject": {
      const expected = body.expected;
      if (expected !== "unverified" && expected !== "pending" && expected !== "rejected") return bad("expected");
      if (body.override !== undefined && typeof body.override !== "boolean") return bad("override");
      const reason = between(body.reason, 3, 300);
      if (!reason) return { ok: false, status: 400, error: "reason_required" };
      return { ok: true, action: { action: act, expected, reason, override: act === "approve" && body.override === true, clientActionId } };
    }
    case "suspend":
    case "reactivate": {
      const expected = body.expected;
      if (expected !== "active" && expected !== "suspended") return bad("expected");
      const reason = between(body.reason, 3, 300);
      if (!reason) return { ok: false, status: 400, error: "reason_required" };
      return { ok: true, action: { action: act, expected, reason, clientActionId } };
    }
  }
}

// ── onboarding ───────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VEHICLES = ["ev_bike", "bike", "scooter", "bicycle", "other"] as const;

export interface OnboardRiderInput {
  clientActionId: string;
  fullName: string;
  /** E.164. */
  mobile: string;
  email: string | null;
  password: string | null;
  zoneId: string;
  vehicleType: (typeof VEHICLES)[number] | null;
  vehicleOwner: "deligro" | "rider";
  vehicleRegistration: string | null;
  licenceNumber: string | null;
  licenceExpiresOn: string | null;
  addressLine: string | null;
  pincode: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  emergencyRelation: string | null;
}

export function parseOnboardRiderBody(body: Record<string, unknown> | null): { ok: true; input: OnboardRiderInput } | { ok: false; field: string } {
  if (!body) return { ok: false, field: "body" };
  const f = (field: string) => ({ ok: false as const, field });
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return f("clientActionId");
  const fullName = between(body.fullName, 2, 80);
  if (!fullName) return f("fullName");
  const mobile = typeof body.mobile === "string" ? toE164(body.mobile) : null;
  if (!mobile || !/^\+91[6-9]\d{9}$/.test(mobile)) return f("mobile");
  const email = text(body.email);
  if (email && (!EMAIL.test(email) || email.length > 120)) return f("email");
  const password = text(body.password);
  if (password && (password.length < 8 || password.length > 72)) return f("password");
  if (typeof body.zoneId !== "string" || !isUuid(body.zoneId)) return f("zoneId");
  const vehicleType = body.vehicleType === undefined || body.vehicleType === null ? null : body.vehicleType;
  if (vehicleType !== null && !VEHICLES.includes(vehicleType as (typeof VEHICLES)[number])) return f("vehicleType");
  const vehicleOwner = body.vehicleOwner === undefined || body.vehicleOwner === null ? "deligro" : body.vehicleOwner;
  if (vehicleOwner !== "deligro" && vehicleOwner !== "rider") return f("vehicleOwner");
  const vehicleRegistration = text(body.vehicleRegistration);
  if (vehicleRegistration && vehicleRegistration.length > 20) return f("vehicleRegistration");
  const licenceNumber = text(body.licenceNumber);
  if (licenceNumber && !/^[A-Za-z0-9 -]{6,20}$/.test(licenceNumber)) return f("licenceNumber");
  const licenceExpiresOn = text(body.licenceExpiresOn);
  if (licenceExpiresOn && !isDay(licenceExpiresOn)) return f("licenceExpiresOn");
  const addressLine = text(body.addressLine);
  if (addressLine && addressLine.length > 200) return f("addressLine");
  const pincode = text(body.pincode);
  if (pincode && !/^\d{6}$/.test(pincode)) return f("pincode");
  const emergencyName = text(body.emergencyName);
  if (emergencyName && emergencyName.length > 80) return f("emergencyName");
  const emergencyRaw = text(body.emergencyPhone);
  const emergencyPhone = emergencyRaw ? toE164(emergencyRaw) : null;
  if (emergencyRaw && (!emergencyPhone || !/^\+?\d{10,13}$/.test(emergencyPhone))) return f("emergencyPhone");
  const emergencyRelation = text(body.emergencyRelation);
  if (emergencyRelation && emergencyRelation.length > 40) return f("emergencyRelation");
  return {
    ok: true,
    input: {
      clientActionId: body.clientActionId,
      fullName,
      mobile,
      email,
      password,
      zoneId: body.zoneId.toLowerCase(),
      vehicleType: vehicleType as OnboardRiderInput["vehicleType"],
      vehicleOwner,
      vehicleRegistration,
      licenceNumber,
      licenceExpiresOn,
      addressLine,
      pincode,
      emergencyName,
      emergencyPhone,
      emergencyRelation,
    },
  };
}

/**
 * The login email for a new rider: theirs when given, else the phone-only
 * account address every OTP customer already gets (src/lib/auth/phone.ts), so a
 * rider who later orders food signs into the same account.
 */
export function loginEmailFor(i: { email: string | null; mobile: string }): string {
  return i.email ?? phoneToSyntheticEmail(i.mobile);
}

// ── documents ────────────────────────────────────────────────────────────────

const NUMBER_RULES: Partial<Record<RiderDocType, RegExp>> = {
  aadhaar: /^\d{12}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  driving_licence: /^[A-Z0-9-]{8,20}$/,
  vehicle_rc: /^[A-Z0-9-]{6,15}$/,
};

/** Normalised number (spaces out, upper-case), and the rules each type's fields follow. */
export function validateRiderDocFields(
  type: string,
  number: string | null,
  expiresOn: string | null
):
  | { ok: true; type: RiderDocType; number: string | null; expiresOn: string | null }
  | { ok: false; error: "bad_type" | "invalid_number" | "expiry_required" } {
  if (!RIDER_DOC_TYPES.includes(type as RiderDocType)) return { ok: false, error: "bad_type" };
  const t = type as RiderDocType;
  const clean = number ? number.replace(/\s+/g, "").toUpperCase() : null;
  const rule = NUMBER_RULES[t];
  if (clean && rule && !rule.test(clean)) return { ok: false, error: "invalid_number" };
  if (clean && !rule && clean.length > 30) return { ok: false, error: "invalid_number" };
  if (expiresOn !== null && !isDay(expiresOn)) return { ok: false, error: "expiry_required" };
  if (EXPIRING_RIDER_DOCS.includes(t) && !expiresOn) return { ok: false, error: "expiry_required" };
  return { ok: true, type: t, number: clean, expiresOn };
}

/** An earlier call with this onboarding's clientActionId, as the audit log recorded it. */
export interface PriorAction {
  actor_id: string;
  action: string;
  entity_id: string;
}

/**
 * What an earlier call with the same id means for this onboarding: the same
 * onboarding replayed (answer with the rider it created, no credentials),
 * someone else's id (stale), or this manager's id spent on a different action
 * (conflict — never answer with that action's record).
 */
export function replayAnswer(
  prior: PriorAction | null,
  actorId: string
): { kind: "same"; riderId: string } | { kind: "stale" } | { kind: "conflict" } | null {
  if (!prior) return null;
  if (prior.actor_id !== actorId) return { kind: "stale" };
  if (prior.action !== "rider.onboard") return { kind: "conflict" };
  return { kind: "same", riderId: prior.entity_id };
}

/**
 * Two sends of one onboarding race: the second finds the login already taken
 * because the first is still finishing. Before calling that "phone taken", look
 * for the first call's audit row for a short while, so the loser answers with
 * the winner's rider instead of an error about the person it just created.
 */
export async function awaitPriorOnboard(
  lookup: () => Promise<PriorAction | null>,
  opts: { tries?: number; sleep?: (ms: number) => Promise<void>; intervalMs?: number } = {}
): Promise<PriorAction | null> {
  const tries = opts.tries ?? 12;
  const interval = opts.intervalMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i += 1) {
    const prior = await lookup();
    if (prior) return prior;
    if (i < tries - 1) await sleep(interval);
  }
  return null;
}

export const RIDER_DOC_MAX_BYTES = 10 * 1024 * 1024;
export const RIDER_DOC_MIME = ["application/pdf", "image/jpeg", "image/png"] as const;

// ── errors ───────────────────────────────────────────────────────────────────

/** A rider RPC's error → the pinned answer (Phase 3's mapping plus the rider codes). */
export function mapRiderRpcError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  const list = (s: string | null | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (message === "documents_unverified") return { ok: false, status: 409, error: "documents_unverified", extra: { missing: list(e.details) } };
  if (message === "active_delivery") return { ok: false, status: 409, error: "active_delivery", extra: { orders: list(e.details) } };
  if (message === "already_decided" || message === "already_resolved") return { ok: false, status: 409, error: message };
  if (message === "expiry_required" || message === "bad_type") return { ok: false, status: 400, error: message };
  if (message === "invalid_amount" || message === "invalid_kind" || message === "invalid_date" || message === "invalid_profile") {
    return { ok: false, status: 400, error: "bad_request", extra: { field: message.replace("invalid_", "") } };
  }
  return mapRpcError(e);
}
