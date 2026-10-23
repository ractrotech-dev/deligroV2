import { addDays, isDayKey } from "@/lib/rider/earnings-math";
import { isLockedCategory, isNotificationCategory, type NotificationCategory } from "@/lib/rider/notification-prefs";

/**
 * Rider profile and documents — the rules, with no database (migration 0086;
 * plan: docs/superpowers/plans/2026-10-21-rider-app-phase-6-profile-documents.md).
 *
 * Pure on purpose (no `server-only`): `scripts/qa/rider-profile.ts` runs it
 * under tsx, the routes and the admin screens share it, and dispatch asks it
 * whether expired documents keep a rider off the road.
 *
 * Two things here are sensitive and are decided only here:
 *
 *   * **Masking.** An Aadhaar number is reduced to `XXXX-XXXX-<last 4>` before
 *     it reaches the database (and the 0086 trigger does it again for any
 *     other writer); every other number is shown as `XXXX<last 4>`. Bank
 *     accounts and UPI ids are shown to the rider the same way.
 *   * **Input.** Every body field is checked against a closed shape — unknown
 *     keys are refused, text is NFC-normalised and trimmed but kept in any
 *     script (a name typed in Devanagari is stored as typed), control
 *     characters are refused.
 */

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const RIDER_DOC_TYPES = ["aadhaar", "pan", "driving_licence", "vehicle_rc", "insurance", "puc", "photo"] as const;
export type RiderDocType = (typeof RIDER_DOC_TYPES)[number];

/** Needed for verification whoever owns the vehicle. */
export const REQUIRED_DOC_TYPES: readonly RiderDocType[] = ["aadhaar", "driving_licence", "photo"];
/** Needed only when the rider rides their own vehicle (Deligro supplies the EV bike). */
export const VEHICLE_DOC_TYPES: readonly RiderDocType[] = ["vehicle_rc", "insurance", "puc"];
/** An upload of these must carry its expiry date. */
export const EXPIRY_REQUIRED_TYPES: readonly RiderDocType[] = ["driving_licence", "insurance", "puc"];

export const DOC_TYPE_LABEL: Record<RiderDocType, string> = {
  aadhaar: "Aadhaar",
  pan: "PAN card",
  driving_licence: "Driving licence",
  vehicle_rc: "Vehicle RC",
  insurance: "Insurance",
  puc: "PUC certificate",
  photo: "Photo",
};

/**
 * 4 MB. The bucket allows 10 MB (0086, identical to 0150), but a serverless
 * request body is capped at about 4.5 MB on the host, so the server refuses
 * anything larger before it is read; the app compresses photos to fit.
 */
export const DOC_MAX_BYTES = 4 * 1024 * 1024;
export const DOC_MIME_EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" } as const;
export type DocMime = keyof typeof DOC_MIME_EXT;
export const DOC_MIME_TYPES = Object.keys(DOC_MIME_EXT) as DocMime[];

export const VEHICLE_TYPES = ["ev_bike", "bike", "scooter", "bicycle", "other"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = {
  ev_bike: "EV bike",
  bike: "Motorbike",
  scooter: "Scooter",
  bicycle: "Bicycle",
  other: "Other",
};
export const VEHICLE_OWNERS = ["deligro", "rider"] as const;
export type VehicleOwner = (typeof VEHICLE_OWNERS)[number];

export const VERIFICATION_STATES = ["unverified", "pending", "verified", "rejected"] as const;
export type Verification = (typeof VERIFICATION_STATES)[number];

export const CHANGE_FIELDS = ["full_name", "licence", "vehicle", "payout_account"] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];
export const CHANGE_FIELD_LABEL: Record<ChangeField, string> = {
  full_name: "Name",
  licence: "Driving licence",
  vehicle: "Vehicle",
  payout_account: "Payout account",
};

export function isRiderDocType(v: unknown): v is RiderDocType {
  return typeof v === "string" && (RIDER_DOC_TYPES as readonly string[]).includes(v);
}

export function isVerification(v: unknown): v is Verification {
  return typeof v === "string" && (VERIFICATION_STATES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// masking
// ---------------------------------------------------------------------------

/** `XXXX` and the last four characters; four or fewer are masked entirely. */
function lastFour(clean: string): string {
  return clean.length <= 4 ? "XXXX" : `XXXX${clean.slice(-4)}`;
}

/**
 * What anyone but the server sees of a document number. Aadhaar is
 * `XXXX-XXXX-1234` (its familiar 4-4-4 shape); everything else `XXXX` + the
 * last four. The same rule as the Manager branch's `maskNumber`, so both
 * surfaces show one value.
 */
export function maskDocNumber(type: RiderDocType | string, number: string | null | undefined): string | null {
  if (number === null || number === undefined) return null;
  const clean = number.replace(/[\s-]+/g, "").toUpperCase();
  if (clean === "") return null;
  if (type === "aadhaar") {
    const digits = clean.replace(/\D/g, "");
    return digits.length >= 4 ? `XXXX-XXXX-${digits.slice(-4)}` : "XXXX-XXXX-XXXX";
  }
  return lastFour(clean);
}

export function maskAccountNumber(n: string | null | undefined): string | null {
  if (!n) return null;
  return lastFour(n.replace(/\s+/g, ""));
}

/** `XXXX` + the last four of the handle, and the provider in clear: `XXXX3210@ybl`. */
export function maskUpiId(id: string | null | undefined): string | null {
  if (!id) return null;
  const at = id.lastIndexOf("@");
  if (at <= 0) return "XXXX";
  const local = id.slice(0, at);
  return `${local.length <= 4 ? "XXXX" : `XXXX${local.slice(-4)}`}@${id.slice(at + 1)}`;
}

export function maskPayoutAccount(a: { kind: string; accountNumber: string | null; upiId: string | null }): string {
  return (a.kind === "upi" ? maskUpiId(a.upiId) : maskAccountNumber(a.accountNumber)) ?? "XXXX";
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

// Control characters (C0, DEL, C1) and the bidi overrides that make a string
// display as something it is not. Everything else — any script — is kept.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * A free-text field: NFC, trimmed, inner whitespace runs collapsed. `""` and
 * null clear it (null); a non-string, a control character or more than `max`
 * characters is refused (undefined).
 */
export function cleanText(raw: unknown, max: number): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const s = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (UNSAFE_TEXT.test(raw.replace(/[\t\n\r]/g, " "))) return undefined;
  if (s === "") return null;
  if ([...s].length > max) return undefined;
  return s;
}

/** A person's name in any script: letters, combining marks, spaces, `.`, `'`, `-`. */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

export function cleanName(raw: unknown, min = 2, max = 80): string | undefined {
  const s = cleanText(raw, max);
  if (!s || [...s].length < min || !NAME.test(s)) return undefined;
  return s;
}

/** `+91 98765-43210` → `+919876543210`; null when it is not 10–13 digits. */
export function normalizePhone(raw: unknown): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/[\s()-]+/g, "");
  return /^\+?\d{10,13}$/.test(s) ? s : undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(obj).find((k) => !allowed.includes(k)) ?? null;
}

// ---------------------------------------------------------------------------
// documents: input and file
// ---------------------------------------------------------------------------

const NUMBER_RULE: Partial<Record<RiderDocType, RegExp>> = {
  aadhaar: /^\d{12}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  driving_licence: /^[A-Z0-9-]{8,20}$/,
  vehicle_rc: /^[A-Z0-9-]{6,15}$/,
};
/** An upload of these must carry the document's number. */
const NUMBER_REQUIRED: readonly RiderDocType[] = ["aadhaar", "pan", "driving_licence"];
/** A photo has no number; one sent is ignored. */
const NO_NUMBER: readonly RiderDocType[] = ["photo"];

export type DocumentInputError = "bad_type" | "invalid_number" | "expiry_required" | "invalid_expiry";

export interface DocumentInput {
  type: RiderDocType;
  /** What is stored in `rider_documents.number`: null for Aadhaar, always. */
  number: string | null;
  numberMasked: string | null;
  expiresOn: string | null;
}

/**
 * The fields of an upload. `today` is the IST day: an expiry before it is
 * refused (`invalid_expiry` — the document is already out of date), today
 * itself is fine (valid through the day).
 */
export function validateDocumentInput(
  input: { type: unknown; number?: unknown; expiresOn?: unknown },
  today: string
): { ok: true; value: DocumentInput } | { ok: false; error: DocumentInputError } {
  if (!isRiderDocType(input.type)) return { ok: false, error: "bad_type" };
  const type = input.type;

  let clean: string | null = null;
  if (!NO_NUMBER.includes(type) && input.number !== undefined && input.number !== null && input.number !== "") {
    if (typeof input.number !== "string") return { ok: false, error: "invalid_number" };
    clean = input.number.replace(/\s+/g, "").toUpperCase();
    if (type === "aadhaar") clean = clean.replace(/-/g, "");
    const rule = NUMBER_RULE[type];
    if (rule ? !rule.test(clean) : clean.length === 0 || clean.length > 30 || !/^[A-Z0-9/-]+$/.test(clean)) {
      return { ok: false, error: "invalid_number" };
    }
  }
  if (clean === null && NUMBER_REQUIRED.includes(type)) return { ok: false, error: "invalid_number" };

  let expiresOn: string | null = null;
  if (input.expiresOn !== undefined && input.expiresOn !== null && input.expiresOn !== "") {
    if (!isDayKey(input.expiresOn) || input.expiresOn < today) return { ok: false, error: "invalid_expiry" };
    expiresOn = input.expiresOn;
  }
  if (expiresOn === null && EXPIRY_REQUIRED_TYPES.includes(type)) return { ok: false, error: "expiry_required" };

  return {
    ok: true,
    value: {
      type,
      number: type === "aadhaar" ? null : clean,
      numberMasked: maskDocNumber(type, clean),
      expiresOn,
    },
  };
}

/**
 * The declared type and size of an upload, before its bytes are read: size
 * first (a 40 MB anything is `too_large`), then the type. The magic-byte check
 * (`assertRealType`) runs after this, on the server.
 */
export function checkDocumentFile(file: { type: string; size: number }):
  | { ok: true; ext: (typeof DOC_MIME_EXT)[DocMime] }
  | { ok: false; error: "bad_type" | "too_large" } {
  if (file.size > DOC_MAX_BYTES) return { ok: false, error: "too_large" };
  const ext = (DOC_MIME_EXT as Record<string, (typeof DOC_MIME_EXT)[DocMime] | undefined>)[file.type];
  if (!ext || file.size <= 0) return { ok: false, error: "bad_type" };
  return { ok: true, ext };
}

// ---------------------------------------------------------------------------
// the profile: what saves directly, what waits
// ---------------------------------------------------------------------------

/**
 * Whether a change waits for an admin. The payout account always does (it
 * routes money). Name, licence and vehicle do once the rider has EVER been
 * verified (`verified_at` set) — not "is verified now": an upload or a
 * decision moves the status, and a status that moved must never reopen a
 * field that was verified once. Before any verification there is nothing
 * verified to protect, and they save directly (spec §12).
 */
export function needsApproval(field: ChangeField, everVerified: boolean): boolean {
  if (field === "payout_account") return true;
  return everVerified;
}

/** Ever verified: `verified_at` is set (or, defensively, the status says verified). */
export function wasEverVerified(row: { verification_status?: string | null; verified_at?: string | null } | null | undefined): boolean {
  return !!row && (row.verified_at != null || row.verification_status === "verified");
}

export interface ProfilePatch {
  /** Only the sub-fields that were sent; null clears one. */
  address?: { line?: string | null; city?: string | null; pincode?: string | null };
  emergency?: { name?: string | null; phone?: string | null; relation?: string | null };
  /** Saved directly only while the rider is not verified (the data layer checks). */
  vehicleType?: VehicleType;
  /** category -> on/off; only the categories sent change (merged into what is stored). */
  notificationPrefs?: Partial<Record<NotificationCategory, boolean>>;
}

/**
 * A PATCH body that carries nothing but `notificationPrefs`: not an edit of the
 * profile, so the `driver.profile_edit` switch does not apply to it (P7-R5).
 * Judged on the raw body, before validation; a body that is not an object, or
 * has any other key, is not.
 */
export function isNotificationPrefsOnly(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "notificationPrefs";
}

type Invalid = { ok: false; error: "invalid_value" | "locked_category"; field: string };
const invalid = (field: string): Invalid => ({ ok: false, error: "invalid_value", field });

/**
 * PATCH /api/rider/profile's body: `address`, `emergency`, `vehicleType` and
 * `notificationPrefs`, nothing else. A sub-field left out keeps its value; `""` or null clears it.
 */
export function parseProfilePatch(body: unknown): { ok: true; value: ProfilePatch } | Invalid {
  if (!isPlainObject(body)) return invalid("body");
  const extra = unknownKey(body, ["address", "emergency", "vehicleType", "notificationPrefs"]);
  if (extra) return invalid(extra);
  if (Object.keys(body).length === 0) return invalid("body");
  const out: ProfilePatch = {};

  if (body.address !== undefined) {
    if (!isPlainObject(body.address)) return invalid("address");
    const a = body.address;
    const bad = unknownKey(a, ["line", "city", "pincode"]);
    if (bad) return invalid(`address.${bad}`);
    const line = a.line === undefined ? undefined : cleanText(a.line, 200);
    if (a.line !== undefined && line === undefined) return invalid("address.line");
    const city = a.city === undefined ? undefined : cleanText(a.city, 80);
    if (a.city !== undefined && city === undefined) return invalid("address.city");
    let pincode: string | null | undefined;
    if (a.pincode !== undefined) {
      if (a.pincode === null || a.pincode === "") pincode = null;
      else if (typeof a.pincode === "string" && /^\d{6}$/.test(a.pincode.replace(/\s+/g, ""))) pincode = a.pincode.replace(/\s+/g, "");
      else return invalid("address.pincode");
    }
    out.address = {};
    if (a.line !== undefined) out.address.line = line ?? null;
    if (a.city !== undefined) out.address.city = city ?? null;
    if (a.pincode !== undefined) out.address.pincode = pincode ?? null;
  }

  if (body.emergency !== undefined) {
    if (!isPlainObject(body.emergency)) return invalid("emergency");
    const e = body.emergency;
    const bad = unknownKey(e, ["name", "phone", "relation"]);
    if (bad) return invalid(`emergency.${bad}`);
    let name: string | null | undefined;
    if (e.name !== undefined) {
      name = e.name === null || e.name === "" ? null : cleanName(e.name);
      if (name === undefined) return invalid("emergency.name");
    }
    const phone = e.phone === undefined ? undefined : normalizePhone(e.phone);
    if (e.phone !== undefined && phone === undefined) return invalid("emergency.phone");
    const relation = e.relation === undefined ? undefined : cleanText(e.relation, 40);
    if (e.relation !== undefined && relation === undefined) return invalid("emergency.relation");
    out.emergency = {};
    if (e.name !== undefined) out.emergency.name = name ?? null;
    if (e.phone !== undefined) out.emergency.phone = phone ?? null;
    if (e.relation !== undefined) out.emergency.relation = relation ?? null;
  }

  if (body.vehicleType !== undefined) {
    if (!(VEHICLE_TYPES as readonly unknown[]).includes(body.vehicleType)) return invalid("vehicleType");
    out.vehicleType = body.vehicleType as VehicleType;
  }

  if (body.notificationPrefs !== undefined) {
    if (!isPlainObject(body.notificationPrefs)) return invalid("notificationPrefs");
    const prefs: Partial<Record<NotificationCategory, boolean>> = {};
    for (const [key, on] of Object.entries(body.notificationPrefs)) {
      if (!isNotificationCategory(key)) return invalid(`notificationPrefs.${key}`);
      if (typeof on !== "boolean") return invalid(`notificationPrefs.${key}`);
      // Switching a locked category off is refused; switching it on changes nothing.
      if (isLockedCategory(key) && !on) return { ok: false, error: "locked_category", field: `notificationPrefs.${key}` };
      prefs[key] = on;
    }
    out.notificationPrefs = prefs;
  }
  return { ok: true, value: out };
}

export interface BankAccountInput {
  kind: "bank";
  holderName: string;
  accountNumber: string;
  ifsc: string;
}
export interface UpiAccountInput {
  kind: "upi";
  upiId: string;
  holderName: string | null;
}
export type PayoutAccountInput = BankAccountInput | UpiAccountInput;

export type ChangeValue =
  | { field: "full_name"; value: { fullName: string } }
  | { field: "licence"; value: { number: string; expiresOn: string } }
  | { field: "vehicle"; value: { type: VehicleType; owner: VehicleOwner; registration: string | null } }
  | { field: "payout_account"; value: PayoutAccountInput };

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/;

/** A payout account as typed (bank: holder, number twice, IFSC; UPI: the id). */
export function parsePayoutAccount(v: unknown): { ok: true; value: PayoutAccountInput } | Invalid {
  if (!isPlainObject(v)) return invalid("value");
  if (v.kind === "bank") {
    const bad = unknownKey(v, ["kind", "holderName", "accountNumber", "confirmAccountNumber", "ifsc"]);
    if (bad) return invalid(bad);
    const holderName = cleanName(v.holderName, 2, 100);
    if (!holderName) return invalid("holderName");
    const acct = typeof v.accountNumber === "string" ? v.accountNumber.replace(/\s+/g, "") : "";
    if (!/^\d{9,18}$/.test(acct)) return invalid("accountNumber");
    const confirm = typeof v.confirmAccountNumber === "string" ? v.confirmAccountNumber.replace(/\s+/g, "") : "";
    if (confirm !== acct) return invalid("confirmAccountNumber");
    const ifsc = typeof v.ifsc === "string" ? v.ifsc.replace(/\s+/g, "").toUpperCase() : "";
    if (!IFSC.test(ifsc)) return invalid("ifsc");
    return { ok: true, value: { kind: "bank", holderName, accountNumber: acct, ifsc } };
  }
  if (v.kind === "upi") {
    const bad = unknownKey(v, ["kind", "upiId", "holderName"]);
    if (bad) return invalid(bad);
    const upiId = typeof v.upiId === "string" ? v.upiId.trim().toLowerCase() : "";
    if (!UPI.test(upiId)) return invalid("upiId");
    let holderName: string | null = null;
    if (v.holderName !== undefined && v.holderName !== null && v.holderName !== "") {
      const h = cleanName(v.holderName, 2, 100);
      if (!h) return invalid("holderName");
      holderName = h;
    }
    return { ok: true, value: { kind: "upi", upiId, holderName } };
  }
  return invalid("kind");
}

/** `value` for one change-request field, normalised. */
export function parseChangeValue(field: ChangeField, value: unknown, today: string): { ok: true; change: ChangeValue } | Invalid {
  if (field === "payout_account") {
    const p = parsePayoutAccount(value);
    return p.ok ? { ok: true, change: { field, value: p.value } } : p;
  }
  if (!isPlainObject(value)) return invalid("value");
  if (field === "full_name") {
    const bad = unknownKey(value, ["fullName"]);
    if (bad) return invalid(bad);
    const fullName = cleanName(value.fullName);
    return fullName ? { ok: true, change: { field, value: { fullName } } } : invalid("fullName");
  }
  if (field === "licence") {
    const bad = unknownKey(value, ["number", "expiresOn"]);
    if (bad) return invalid(bad);
    const number = typeof value.number === "string" ? value.number.replace(/\s+/g, "").toUpperCase() : "";
    if (!NUMBER_RULE.driving_licence!.test(number)) return invalid("number");
    if (!isDayKey(value.expiresOn) || value.expiresOn < today) return invalid("expiresOn");
    return { ok: true, change: { field, value: { number, expiresOn: value.expiresOn } } };
  }
  // vehicle
  const bad = unknownKey(value, ["type", "owner", "registration"]);
  if (bad) return invalid(bad);
  if (!(VEHICLE_TYPES as readonly unknown[]).includes(value.type)) return invalid("type");
  if (!(VEHICLE_OWNERS as readonly unknown[]).includes(value.owner)) return invalid("owner");
  let registration: string | null = null;
  if (value.registration !== undefined && value.registration !== null && value.registration !== "") {
    const reg = typeof value.registration === "string" ? value.registration.replace(/\s+/g, "").toUpperCase() : "";
    if (!NUMBER_RULE.vehicle_rc!.test(reg)) return invalid("registration");
    registration = reg;
  }
  return {
    ok: true,
    change: { field, value: { type: value.type as VehicleType, owner: value.owner as VehicleOwner, registration } },
  };
}

/** POST /api/rider/profile/change-requests' body: `{ field, value }`. */
export function parseChangeRequest(
  body: unknown,
  today: string
):
  | ({ ok: true } & ChangeValue)
  | Invalid
  | { ok: false; error: "invalid_field" } {
  if (!isPlainObject(body)) return invalid("body");
  const extra = unknownKey(body, ["field", "value"]);
  if (extra) return invalid(extra);
  if (!(CHANGE_FIELDS as readonly unknown[]).includes(body.field)) return { ok: false, error: "invalid_field" };
  const parsed = parseChangeValue(body.field as ChangeField, body.value, today);
  if (!parsed.ok) return parsed;
  return { ok: true, ...parsed.change } as { ok: true } & ChangeValue;
}

/** One line for a pending change, as the rider and the admin list show it. Never a full number. */
export function changeSummary(change: ChangeValue | { field: string; value: unknown }, payoutMasked?: string | null): string {
  const v = change.value as Record<string, unknown> | null;
  switch (change.field) {
    case "full_name":
      return typeof v?.fullName === "string" ? v.fullName : "New name";
    case "licence":
      return [maskDocNumber("driving_licence", typeof v?.number === "string" ? v.number : null), typeof v?.expiresOn === "string" ? `valid to ${v.expiresOn}` : null]
        .filter(Boolean)
        .join(" · ") || "New licence";
    case "vehicle": {
      const type = typeof v?.type === "string" && v.type in VEHICLE_TYPE_LABEL ? VEHICLE_TYPE_LABEL[v.type as VehicleType] : "Vehicle";
      const owner = v?.owner === "rider" ? "own vehicle" : v?.owner === "deligro" ? "Deligro's vehicle" : null;
      return [type, typeof v?.registration === "string" ? v.registration : null, owner].filter(Boolean).join(" · ");
    }
    case "payout_account":
      return payoutMasked ?? "New payout account";
    default:
      return "Change";
  }
}

// ---------------------------------------------------------------------------
// documents: complete, expired, blocked, reminded
// ---------------------------------------------------------------------------

export interface DocLike {
  type: string;
  status: string;
  expiresOn: string | null;
  /** `rider_documents.created_at` (ISO): when it was uploaded. Read by the dispatch block (M3). */
  uploadedAt?: string | null;
}

/** The IST calendar day of an ISO instant. */
const istDayOfIso = (iso: string): string => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

/** Whole days from `today` to `day` (0 = today; negative = past). */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Past its last valid day, or already marked expired. */
export function isExpired(doc: DocLike, today: string): boolean {
  return doc.status === "expired" || (doc.expiresOn !== null && doc.expiresOn < today);
}

/** The documents this rider must hold: three, or six on their own vehicle. */
export function requiredDocTypes(owner: VehicleOwner | string | null | undefined): RiderDocType[] {
  return owner === "rider" ? [...REQUIRED_DOC_TYPES, ...VEHICLE_DOC_TYPES] : [...REQUIRED_DOC_TYPES];
}

export interface DocumentsStatus {
  required: RiderDocType[];
  /** Required and never uploaded (or only replaced rows). */
  missing: RiderDocType[];
  /** Required, uploaded, waiting for Deligro. */
  awaitingReview: RiderDocType[];
  /** Required and rejected: upload again. */
  rejected: RiderDocType[];
  /** Required and past expiry. */
  expired: RiderDocType[];
  /** Every required document verified and in date. */
  complete: boolean;
}

export function documentsStatus(docs: readonly DocLike[], owner: VehicleOwner | string | null | undefined, today: string): DocumentsStatus {
  const live = docs.filter((d) => d.status !== "replaced");
  const required = requiredDocTypes(owner);
  const s: DocumentsStatus = { required, missing: [], awaitingReview: [], rejected: [], expired: [], complete: false };
  for (const type of required) {
    const d = live.find((x) => x.type === type);
    if (!d) s.missing.push(type);
    else if (d.status === "rejected") s.rejected.push(type);
    else if (isExpired(d, today)) s.expired.push(type);
    else if (d.status !== "verified") s.awaitingReview.push(type);
  }
  s.complete = s.missing.length + s.rejected.length + s.expired.length + s.awaitingReview.length === 0;
  return s;
}

export function documentsComplete(docs: readonly DocLike[], owner: VehicleOwner | string | null | undefined, today: string): boolean {
  return documentsStatus(docs, owner, today).complete;
}

/**
 * Review Focus 4. With `block_dispatch_on_expired_docs` off (the default) an
 * expired document never keeps a rider off the road: it is pushed and
 * flagged. On, an expired document that applies to the rider does.
 *
 * Ruling P8-R8: once a document type that applies to the rider has expired —
 * any row of that type past its day, whatever became of it (replaced by a new
 * upload, rejected by staff) — the type stays blocked until a VERIFIED, in-date
 * document of it exists. Pending and rejected rows never clear the block, so
 * re-uploading any picture with a far-off expiry, or staff rejecting the
 * expired document, no longer puts the rider back on the road. `docs` must
 * therefore include replaced and rejected rows.
 *
 * A type that never expired never blocks here — a missing document, or a new
 * rider's documents waiting for review, is verification's business, not this
 * switch's.
 *
 * "Expired at some point" means the row was LIVE when its date passed (review
 * M3): a row not replaced and past its day, or a replaced row whose day passed
 * before it was replaced. Rows carry no replaced-at time, so the day its
 * successor (the next upload of that type) arrived stands in for it; a
 * licence renewed early therefore never blocks. A replaced row with no upload
 * times to compare is counted (fail closed).
 */
export function dispatchBlockedByDocuments(
  docs: readonly DocLike[],
  owner: VehicleOwner | string | null | undefined,
  today: string,
  blockOn: boolean
): boolean {
  if (!blockOn) return false;
  return requiredDocTypes(owner).some((type) => {
    const ofType = docs.filter((d) => d.type === type);
    const expiredWhileLive = (d: DocLike): boolean => {
      if (d.status !== "replaced") return isExpired(d, today);
      if (d.expiresOn === null) return false;
      const at = d.uploadedAt;
      const successor = at
        ? ofType
            .filter((x) => x !== d && x.uploadedAt && x.uploadedAt > at)
            .sort((a, b) => (a.uploadedAt! < b.uploadedAt! ? -1 : 1))[0]
        : undefined;
      // Unknown order: count it, as before (fail closed).
      if (!successor?.uploadedAt) return d.expiresOn < today;
      return d.expiresOn < istDayOfIso(successor.uploadedAt);
    };
    return ofType.some(expiredWhileLive) && !ofType.some((d) => d.status === "verified" && !isExpired(d, today));
  });
}

export type ReminderStamp = "reminded_30_at" | "reminded_7_at" | "reminded_1_at" | "reminded_expired_at";
export interface ReminderDoc {
  expiresOn: string | null;
  status: string;
  reminded30: boolean;
  reminded7: boolean;
  reminded1: boolean;
  remindedExpired: boolean;
}

/**
 * The reminder to send today, if any: the MOST urgent stage not yet sent, with
 * every less urgent stage stamped alongside it (a licence uploaded five days
 * before expiry gets one "7 days" push, not a 30 and a 7 together). Stages:
 * 30 days (31 > days left >= 8), 7 (7..2), 1 (1 or 0 — "expires today"),
 * expired (past). Only pending, verified or already-expired documents.
 */
export function reminderStage(
  doc: ReminderDoc,
  today: string
): { stage: 30 | 7 | 1 | "expired"; daysLeft: number; stamps: ReminderStamp[] } | null {
  if (!doc.expiresOn || !["pending", "verified", "expired"].includes(doc.status)) return null;
  const daysLeft = daysUntil(doc.expiresOn, today);
  if (daysLeft < 0) {
    return doc.remindedExpired
      ? null
      : { stage: "expired", daysLeft, stamps: ["reminded_30_at", "reminded_7_at", "reminded_1_at", "reminded_expired_at"] };
  }
  if (daysLeft <= 1) return doc.reminded1 ? null : { stage: 1, daysLeft, stamps: ["reminded_30_at", "reminded_7_at", "reminded_1_at"] };
  if (daysLeft <= 7) return doc.reminded7 ? null : { stage: 7, daysLeft, stamps: ["reminded_30_at", "reminded_7_at"] };
  if (daysLeft <= 30) return doc.reminded30 ? null : { stage: 30, daysLeft, stamps: ["reminded_30_at"] };
  return null;
}

/** The latest day a document can expire on and still be due a reminder today. */
export function reminderHorizon(today: string): string {
  return addDays(today, 30);
}

/**
 * Something the RIDER should act on: verification rejected, a required
 * document missing, rejected or expired, or any document expiring within 30
 * days. Waiting for Deligro's review is not the rider's to fix.
 */
export function profileNeedsAttention(p: {
  verification: Verification;
  docs: readonly DocLike[];
  owner: VehicleOwner | string | null | undefined;
  today: string;
}): boolean {
  if (p.verification === "rejected") return true;
  const s = documentsStatus(p.docs, p.owner, p.today);
  if (s.missing.length + s.rejected.length + s.expired.length > 0) return true;
  const horizon = reminderHorizon(p.today);
  return p.docs.some((d) => d.status !== "replaced" && d.status !== "rejected" && d.expiresOn !== null && d.expiresOn <= horizon);
}
