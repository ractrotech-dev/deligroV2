import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import {
  discardStagedPayoutAccount,
  getMaskedPayoutAccount,
  getMaskedStagedAccount,
  stagePayoutAccount,
} from "@/lib/data-access/rider-payout-accounts";
import { assertRealType } from "@/lib/utils/file-signature";
import { notifyRiderDocumentExpiring } from "@/lib/notifications/order-events";
import { istDay } from "@/lib/rider/earnings-math";
import { effectivePrefs, mergeNotificationPrefs, type NotificationCategory } from "@/lib/rider/notification-prefs";
import {
  DOC_MIME_TYPES,
  changeSummary,
  checkDocumentFile,
  daysUntil,
  documentsStatus,
  isVerification,
  needsApproval,
  wasEverVerified,
  parseChangeValue,
  profileNeedsAttention,
  reminderHorizon,
  reminderStage,
  validateDocumentInput,
  type ChangeField,
  type DocumentInputError,
  type DocumentsStatus,
  type ProfilePatch,
  type Verification,
} from "@/lib/rider/profile-rules";

/**
 * A rider's profile, documents and change requests (migration 0086) — the
 * database half of `lib/rider/profile-rules.ts`.
 *
 * ## Authorization
 *
 * Every function takes the rider's id and trusts it: they run on the
 * service-role client (the 0086 tables are service-role-write only, and the
 * raw identity numbers and payout details are not granted to any client). The
 * authorization is therefore the caller's: `/api/rider/profile*` and
 * `/api/rider/documents*` derive the id from the session behind
 * `requireRiderApi()`, and the cron route runs behind `CRON_SECRET`. No id
 * ever comes from a request body, and every read here is filtered to that one
 * rider (`driver_id = <id>`), so another rider's row cannot come back — a
 * document id that is not theirs answers exactly as one that does not exist.
 *
 * Bank and UPI details are not read here: `rider-payout-accounts.ts` is the
 * one module that touches them, and gives this one the masked form only.
 *
 * ## Before 0086 is applied
 *
 * No database has it yet (ruling R2). Reads and writes throw
 * `RiderSchemaPendingError` (the routes answer 503 `migration_pending`);
 * `/api/rider/me` gets null from `getRiderProfileStatus`; dispatch reads "no
 * setting, nobody blocked".
 *
 * The Manager branch created a `rider-profile.ts` with `uploadRiderDocument`
 * and `riderDocumentUrl` first, with the plan's signatures. This file is the
 * Rider plan's full module; when the branches meet, keep one (AGENTS.md, one
 * source of truth) — this one stores Aadhaar masked and records the upload
 * atomically through `rider_add_document`.
 */

const BUCKET = "rider-documents";
/** Ten minutes: long enough to open a file, short enough that a leaked link dies. */
export const SIGNED_URL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_MESSAGE = "migration_pending: rider profile and documents (0086) are not applied";

type PgError = { code?: string; message?: string };

/**
 * The columns migration 0086 adds (rider_profiles, and the platform setting).
 * A column error only means "0086 is not applied" when it names one of these:
 * a typo in some other column is a bug and must surface as a server error, not
 * hide behind a 503.
 */
const COLUMNS_ADDED_BY_0086 = [
  "address_line",
  "city",
  "pincode",
  "vehicle_type",
  "vehicle_owner",
  "vehicle_registration",
  "licence_number",
  "licence_expires_on",
  "emergency_name",
  "emergency_phone",
  "emergency_relation",
  "verification_status",
  "verified_at",
  "verified_by",
  "verification_note",
  "notification_prefs",
  "nav_app",
  "language",
  "block_dispatch_on_expired_docs",
] as const;

const namesColumnOf0086 = (message: string | undefined): boolean =>
  !!message && COLUMNS_ADDED_BY_0086.some((c) => new RegExp(`(^|[^a-z0-9_])${c}($|[^a-z0-9_])`, "i").test(message));

/** A missing column (42703 on a read, PGRST204 on a write) that 0086 would have added. */
function isMissing0086Column(error: PgError): boolean {
  return (isMissingColumn(error) || error.code === "PGRST204") && namesColumnOf0086(error.message);
}

function schemaPending(error: PgError | null | undefined): boolean {
  if (!error) return false;
  return isMissingTable(error) || isMissing0086Column(error) || error.code === "PGRST202" || error.code === "42883";
}

/** A migration-pending error keeps the database error as its `cause`; anything else is rethrown as it came. */
function fail(error: PgError): never {
  if (schemaPending(error)) throw new RiderSchemaPendingError(PENDING_MESSAGE, error);
  throw error;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export interface RiderDocument {
  id: string;
  type: string;
  numberMasked: string | null;
  expiresOn: string | null;
  /** Days from today (IST) to `expiresOn`; negative once past; null without an expiry. */
  daysLeft: number | null;
  status: string;
  remarks: string | null;
  uploadedAt: string;
}

export interface PendingChange {
  id: string;
  field: string;
  createdAt: string;
  /** One line, never a full number: the new name, `XXXX2345 · valid to …`, `XXXX1111`. */
  summary: string;
}

export interface RiderProfile {
  riderCode: string | null;
  name: string | null;
  phone: string | null;
  avatarUrl: string | null;
  address: { line: string | null; city: string | null; pincode: string | null };
  vehicle: { type: string | null; owner: "deligro" | "rider"; registration: string | null };
  licence: { number: string | null; expiresOn: string | null };
  emergency: { name: string | null; phone: string | null; relation: string | null };
  payoutAccount: { kind: "bank" | "upi"; masked: string } | null;
  verification: Verification;
  /** Deligro's note on the last verification decision (why it was rejected, or how it was checked). */
  verificationNote: string | null;
  /** Has ever been verified (verified_at set, or verified now): name, licence, vehicle and payout changes then wait for approval, even after a rejection. */
  everVerified: boolean;
  documents: RiderDocument[];
  documentsStatus: DocumentsStatus;
  pendingChanges: PendingChange[];
  needsAttention: boolean;
  /** Every category with its effective switch; offers, cancellations and safety are always true. */
  notificationPrefs: Record<NotificationCategory, boolean>;
}

interface ProfileRow {
  driver_id: string;
  rider_code: string | null;
  address_line: string | null;
  city: string | null;
  pincode: string | null;
  vehicle_type: string | null;
  vehicle_owner: string | null;
  vehicle_registration: string | null;
  licence_number: string | null;
  licence_expires_on: string | null;
  emergency_name: string | null;
  emergency_phone: string | null;
  emergency_relation: string | null;
  verification_status: string | null;
  verified_at: string | null;
  verification_note: string | null;
}
const PROFILE_COLUMNS =
  "driver_id, rider_code, address_line, city, pincode, vehicle_type, vehicle_owner, vehicle_registration, " +
  "licence_number, licence_expires_on, emergency_name, emergency_phone, emergency_relation, verification_status, " +
  "verified_at, verification_note";

interface DocRow {
  id: string;
  doc_type: string;
  number_masked: string | null;
  expires_on: string | null;
  status: string;
  remarks: string | null;
  created_at: string;
}
const DOC_COLUMNS = "id, doc_type, number_masked, expires_on, status, remarks, created_at";

interface ChangeRow {
  id: string;
  field: string;
  status: string;
  new_value: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

const verificationOf = (v: string | null | undefined): Verification => (isVerification(v) ? v : "unverified");
const ownerOf = (v: string | null | undefined): "deligro" | "rider" => (v === "rider" ? "rider" : "deligro");

function toDocument(row: DocRow, today: string): RiderDocument {
  return {
    id: row.id,
    type: row.doc_type,
    numberMasked: row.number_masked,
    expiresOn: row.expires_on,
    daysLeft: row.expires_on ? daysUntil(row.expires_on, today) : null,
    status: row.status,
    remarks: row.remarks,
    uploadedAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async function readProfileRow(driverId: string): Promise<ProfileRow | null> {
  const { data, error } = await createAdminClient()
    .from("rider_profiles")
    .select(PROFILE_COLUMNS)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<ProfileRow>();
  if (error) fail(error);
  return data ?? null;
}

/**
 * The stored `notification_prefs`, or `{}`. A database whose column is missing
 * (0086 not applied) reads as "nothing switched off": every push stays on,
 * the direction that cannot hide an alert.
 */
async function readStoredNotificationPrefs(driverId: string): Promise<unknown> {
  const { data, error } = await createAdminClient()
    .from("rider_profiles")
    .select("notification_prefs")
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ notification_prefs: unknown }>();
  if (error) {
    // Only this column missing reads as "all on"; any other failure is a failure.
    if (isMissingColumn(error) && /(^|[^a-z0-9_])notification_prefs($|[^a-z0-9_])/i.test(error.message ?? "")) return {};
    fail(error);
  }
  return data?.notification_prefs ?? {};
}

/** The rider's live documents (every status but `replaced`), newest first. */
async function readDocs(driverId: string): Promise<DocRow[]> {
  const { data, error } = await createAdminClient()
    .from("rider_documents")
    .select(DOC_COLUMNS)
    .eq("driver_id", driverId)
    .neq("status", "replaced")
    .order("created_at", { ascending: false })
    .overrideTypes<DocRow[]>();
  if (error) fail(error);
  return data ?? [];
}

async function readChanges(driverId: string, opts: { pendingOnly: boolean; limit?: number }): Promise<ChangeRow[]> {
  let q = createAdminClient()
    .from("rider_profile_change_requests")
    .select("id, field, status, new_value, created_at, decided_at, decision_note")
    .eq("driver_id", driverId);
  if (opts.pendingOnly) q = q.eq("status", "pending");
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 20)
    .overrideTypes<ChangeRow[]>();
  if (error) fail(error);
  return data ?? [];
}

async function summarise(driverId: string, row: ChangeRow): Promise<string> {
  if (row.field === "payout_account") {
    const stagedId = typeof row.new_value?.stagedId === "string" ? row.new_value.stagedId : null;
    const masked = row.status === "pending" && stagedId ? await getMaskedStagedAccount(driverId, stagedId) : null;
    return changeSummary({ field: row.field, value: null }, masked);
  }
  return changeSummary({ field: row.field, value: row.new_value });
}

/** Everything the app's Profile & documents screen shows. */
export async function getRiderProfile(driverId: string, now: Date = new Date()): Promise<RiderProfile> {
  const today = istDay(now);
  const supabase = createAdminClient();
  const [person, row, docs, changes, payout, storedPrefs] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, phone, avatar_url")
      .eq("id", driverId)
      .maybeSingle()
      .overrideTypes<{ full_name: string | null; phone: string | null; avatar_url: string | null }>(),
    readProfileRow(driverId),
    readDocs(driverId),
    readChanges(driverId, { pendingOnly: true }),
    getMaskedPayoutAccount(driverId),
    readStoredNotificationPrefs(driverId),
  ]);
  if (person.error) throw person.error;

  const verification = verificationOf(row?.verification_status);
  const owner = ownerOf(row?.vehicle_owner);
  const documents = docs.map((d) => toDocument(d, today));
  const docLike = documents.map((d) => ({ type: d.type, status: d.status, expiresOn: d.expiresOn }));
  const pendingChanges = await Promise.all(
    changes.map(async (c) => ({ id: c.id, field: c.field, createdAt: c.created_at, summary: await summarise(driverId, c) }))
  );

  return {
    riderCode: row?.rider_code ?? null,
    name: person.data?.full_name?.trim() || null,
    phone: person.data?.phone ?? null,
    avatarUrl: person.data?.avatar_url ?? null,
    address: { line: row?.address_line ?? null, city: row?.city ?? null, pincode: row?.pincode ?? null },
    vehicle: { type: row?.vehicle_type ?? null, owner, registration: row?.vehicle_registration ?? null },
    licence: { number: row?.licence_number ?? null, expiresOn: row?.licence_expires_on ?? null },
    emergency: { name: row?.emergency_name ?? null, phone: row?.emergency_phone ?? null, relation: row?.emergency_relation ?? null },
    payoutAccount: payout,
    verification,
    verificationNote: row?.verification_note ?? null,
    everVerified: wasEverVerified(row),
    documents,
    documentsStatus: documentsStatus(docLike, owner, today),
    pendingChanges,
    needsAttention: profileNeedsAttention({ verification, docs: docLike, owner, today }),
    notificationPrefs: effectivePrefs(storedPrefs),
  };
}

/** The rider's live documents. */
export async function listRiderDocuments(driverId: string, now: Date = new Date()): Promise<RiderDocument[]> {
  const today = istDay(now);
  return (await readDocs(driverId)).map((d) => toDocument(d, today));
}

/**
 * For `/api/rider/me`: where the rider stands, or null on a database without
 * 0086 (the app hides the badge; it is not an error).
 */
export async function getRiderProfileStatus(
  driverId: string,
  now: Date = new Date()
): Promise<{ verification: Verification; documentsComplete: boolean; needsAttention: boolean } | null> {
  try {
    const today = istDay(now);
    const [row, docs] = await Promise.all([readProfileRow(driverId), readDocs(driverId)]);
    const verification = verificationOf(row?.verification_status);
    const owner = ownerOf(row?.vehicle_owner);
    const docLike = docs.map((d) => ({ type: d.doc_type, status: d.status, expiresOn: d.expires_on }));
    return {
      verification,
      documentsComplete: documentsStatus(docLike, owner, today).complete,
      needsAttention: profileNeedsAttention({ verification, docs: docLike, owner, today }),
    };
  } catch (e) {
    if (e instanceof RiderSchemaPendingError) return null;
    throw e;
  }
}

export interface ChangeRequestView {
  id: string;
  field: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  summary: string;
}

/** The rider's last 20 change requests, newest first. The stored value is never echoed. */
export async function listChangeRequests(driverId: string): Promise<ChangeRequestView[]> {
  const rows = await readChanges(driverId, { pendingOnly: false, limit: 20 });
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      field: r.field,
      status: r.status,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      summary: await summarise(driverId, r),
    }))
  );
}

// ---------------------------------------------------------------------------
// writes: the profile
// ---------------------------------------------------------------------------

/**
 * Fields that save directly: address, emergency contact, and the vehicle type
 * while the rider is not verified (a verified vehicle changes through a
 * request). Only the sub-fields sent are written.
 */
export async function updateRiderProfileDirect(
  driverId: string,
  patch: ProfilePatch
): Promise<{ ok: true } | { ok: false; error: "needs_approval"; field: string }> {
  const row = await readProfileRow(driverId);
  if (patch.vehicleType !== undefined && wasEverVerified(row)) {
    return { ok: false, error: "needs_approval", field: "vehicleType" };
  }
  const update: Record<string, unknown> = {};
  const a = patch.address;
  if (a) {
    if ("line" in a) update.address_line = a.line;
    if ("city" in a) update.city = a.city;
    if ("pincode" in a) update.pincode = a.pincode;
  }
  const e = patch.emergency;
  if (e) {
    if ("name" in e) update.emergency_name = e.name;
    if ("phone" in e) update.emergency_phone = e.phone;
    if ("relation" in e) update.emergency_relation = e.relation;
  }
  if (patch.vehicleType !== undefined) update.vehicle_type = patch.vehicleType;
  if (Object.keys(update).length === 0) return { ok: true };
  update.updated_at = new Date().toISOString();

  const supabase = createAdminClient();
  if (row) {
    const { error } = await supabase.from("rider_profiles").update(update).eq("driver_id", driverId);
    if (error) fail(error);
  } else {
    // 0081's trigger creates the row with the driver role; a rider without one
    // (a role set before 0081 ran its backfill) gets it here.
    const { error } = await supabase.from("rider_profiles").insert({ driver_id: driverId, ...update });
    if (error) fail(error);
  }
  return { ok: true };
}

const PREFS_WRITE_ATTEMPTS = 5;

/** The write lost the compare-and-swap `PREFS_WRITE_ATTEMPTS` times in a row: the route answers 409 `conflict`. */
export class NotificationPrefsConflictError extends Error {
  constructor() {
    super("notification_prefs: the write kept losing the race");
    this.name = "NotificationPrefsConflictError";
  }
}

/**
 * Switch notification categories on or off: a direct write, no approval, and
 * the rider's verification state does not matter. Only the categories sent
 * change; the rest of the stored object is kept, and only `false` entries are
 * stored (`true` removes the key).
 *
 * PostgREST cannot run `notification_prefs || ... - ...` in one statement
 * without a SQL function (a migration), so the merge is read-merge-write with
 * a compare-and-swap: the update only matches while the stored object is still
 * what was read, and a lost race re-reads and merges again. Two requests for
 * different categories therefore never undo each other. A missing row is
 * inserted; a concurrent insert loses on the primary key and retries.
 *
 * A database without the column throws `RiderSchemaPendingError`. Five lost
 * races in a row throw `NotificationPrefsConflictError` (the route: 409).
 *
 * UNVERIFIED against a live PostgREST: the `eq` on the jsonb column below is
 * proved in SQL (scripts/qa/sql/migration-0086.mjs) and against the in-memory
 * fake, but it needs one real request on staging (see SECURITY_AUDIT).
 */
export async function updateNotificationPrefs(
  driverId: string,
  changes: Partial<Record<NotificationCategory, boolean>>
): Promise<Record<NotificationCategory, boolean>> {
  // Nothing to change: no write, and no row created for a rider who has none.
  if (Object.keys(changes).length === 0) return effectivePrefs(await readStoredNotificationPrefs(driverId));

  const supabase = createAdminClient();
  for (let attempt = 0; attempt < PREFS_WRITE_ATTEMPTS; attempt++) {
    const { data, error } = await supabase
      .from("rider_profiles")
      .select("notification_prefs")
      .eq("driver_id", driverId)
      .maybeSingle()
      .overrideTypes<{ notification_prefs: unknown }>();
    if (error) fail(error);
    const stored = data ? (data.notification_prefs ?? {}) : null;
    const next = mergeNotificationPrefs(stored, changes);
    const updated_at = new Date().toISOString();

    if (stored === null) {
      const { error: insertError } = await supabase
        .from("rider_profiles")
        .insert({ driver_id: driverId, notification_prefs: next, updated_at });
      if (!insertError) return effectivePrefs(next);
      if (insertError.code === "23505") continue;
      fail(insertError);
    }

    const { data: hit, error: updateError } = await supabase
      .from("rider_profiles")
      .update({ notification_prefs: next, updated_at })
      .eq("driver_id", driverId)
      // jsonb equality: matches only while nobody has written since the read.
      .eq("notification_prefs", JSON.stringify(stored))
      .select("driver_id")
      .overrideTypes<{ driver_id: string }[]>();
    if (updateError) fail(updateError);
    if ((hit ?? []).length > 0) return effectivePrefs(next);
  }
  throw new NotificationPrefsConflictError();
}

export type ChangeRequestResult =
  | { ok: true; id: string; status: "pending" | "applied" }
  | { ok: false; error: "duplicate_pending" | "invalid_value"; field?: string };

const APPLIED_NOTE = "Saved directly: the profile is not verified yet.";

/**
 * A change to name, licence, vehicle or payout account.
 *
 * Waits for an admin when `needsApproval` says so (the payout account always;
 * the rest once the rider has ever been verified — `verified_at` set). Otherwise it is applied at once —
 * through the same `rider_decide_change_request`, with no admin, so every
 * change to these fields leaves a row either way.
 *
 * A payout account is STAGED in its contained table first; the request holds
 * only `{ stagedId }`. While it waits, the approved account is untouched, so a
 * payout being recorded goes where it went before (Review Focus 3).
 */
export async function requestProfileChange(
  driverId: string,
  field: ChangeField,
  value: unknown,
  now: Date = new Date()
): Promise<ChangeRequestResult> {
  const parsed = parseChangeValue(field, value, istDay(now));
  if (!parsed.ok) return { ok: false, error: "invalid_value", field: parsed.field };

  const row = await readProfileRow(driverId);
  const waits = needsApproval(field, wasEverVerified(row));

  let stagedId: string | null = null;
  let newValue: Record<string, unknown>;
  if (parsed.change.field === "payout_account") {
    stagedId = await stagePayoutAccount(driverId, parsed.change.value);
    newValue = { stagedId };
  } else {
    newValue = { ...parsed.change.value };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("rider_profile_change_requests")
    .insert({ driver_id: driverId, field, new_value: newValue, status: "pending" })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    if (stagedId) await discardStagedPayoutAccount(driverId, stagedId);
    if (error.code === "23505") return { ok: false, error: "duplicate_pending" };
    fail(error);
  }
  if (waits) return { ok: true, id: data.id, status: "pending" };

  const { error: applyError } = await supabase.rpc("rider_decide_change_request", {
    p_request: data.id,
    p_actor: null,
    p_decision: "approve",
    p_note: APPLIED_NOTE,
  });
  if (applyError) {
    // The database knows better (verified in between): the request stays
    // pending for an admin, which is what the rider would have got anyway.
    if (/approval_required/.test(applyError.message ?? "")) return { ok: true, id: data.id, status: "pending" };
    // Leave nothing pending that the rider did not ask to wait on.
    await supabase.from("rider_profile_change_requests").delete().eq("id", data.id).eq("status", "pending");
    if (applyError.code === "23514" || /invalid_value/.test(applyError.message ?? "")) {
      return { ok: false, error: "invalid_value", field: "value" };
    }
    fail(applyError);
  }
  return { ok: true, id: data.id, status: "applied" };
}

// ---------------------------------------------------------------------------
// writes: documents
// ---------------------------------------------------------------------------

export type UploadError = "bad_type" | "too_large" | DocumentInputError;

async function removeFile(path: string): Promise<void> {
  try {
    await createAdminClient().storage.from(BUCKET).remove([path]);
  } catch {
    // An orphan object in a private bucket is unreachable without a signed URL.
  }
}

/**
 * The rider's upload. In order, refusing before anything is stored:
 *
 *   1. the fields (`validateDocumentInput`): type, number, expiry;
 *   2. the declared size and type (`checkDocumentFile`): > 4 MB is
 *      `too_large` whatever it is;
 *   3. the bytes (`assertRealType`): a video renamed .pdf is `bad_type`;
 *   4. the object, at `<driverId>/<type>/<uuid>.<ext>` — nothing from the
 *      client shapes the path;
 *   5. the row, through `rider_add_document` (the previous document of that
 *      type becomes `replaced`; an unverified or rejected rider goes to
 *      `pending`, a verified one stays verified — P6-R1). If that fails the
 *      object is removed again.
 *
 * An Aadhaar number is reduced to its last four here; the database trigger
 * does it again for any other writer.
 */
export async function uploadRiderDocument(
  driverId: string,
  input: { type: string; number?: string; expiresOn?: string; file: File },
  now: Date = new Date()
): Promise<{ ok: true; id: string } | { ok: false; error: UploadError }> {
  const fields = validateDocumentInput(input, istDay(now));
  if (!fields.ok) return fields;
  const declared = checkDocumentFile(input.file);
  if (!declared.ok) return declared;
  try {
    await assertRealType(input.file, DOC_MIME_TYPES);
  } catch {
    return { ok: false, error: "bad_type" };
  }

  const { type, number, numberMasked, expiresOn } = fields.value;
  const path = `${driverId}/${type}/${randomUUID()}.${declared.ext}`;
  const supabase = createAdminClient();
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, input.file, { contentType: input.file.type, upsert: false });
  if (uploadError) {
    if (/bucket not found/i.test(uploadError.message)) throw new RiderSchemaPendingError(PENDING_MESSAGE);
    throw uploadError;
  }

  const { data, error } = await supabase.rpc("rider_add_document", {
    p_driver: driverId,
    p_type: type,
    p_number: number,
    p_number_masked: numberMasked,
    p_file_path: path,
    p_expires_on: expiresOn,
  });
  if (error) {
    await removeFile(path);
    const known = /\b(bad_type|expiry_required)\b/.exec(error.message ?? "");
    if (known) return { ok: false, error: known[1] as UploadError };
    fail(error);
  }
  return { ok: true, id: String(data) };
}

/**
 * A 10-minute signed link to one of the rider's OWN live documents, or null —
 * for a malformed id, another rider's document, a replaced one, or none at all
 * alike (the route answers 404 for all of them, and nothing is signed).
 */
export async function riderDocumentUrl(driverId: string, docId: string): Promise<string | null> {
  if (!UUID.test(docId)) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("rider_documents")
    .select("file_path")
    .eq("id", docId)
    .eq("driver_id", driverId)
    .neq("status", "replaced")
    .maybeSingle()
    .overrideTypes<{ file_path: string }>();
  if (error) fail(error);
  if (!data) return null;
  const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(data.file_path, SIGNED_URL_SECONDS);
  if (signError) throw signError;
  return signed?.signedUrl ?? null;
}

// ---------------------------------------------------------------------------
// the daily cron: expiry reminders
// ---------------------------------------------------------------------------

interface ReminderRow {
  id: string;
  driver_id: string;
  doc_type: string;
  expires_on: string | null;
  status: string;
  reminded_30_at: string | null;
  reminded_7_at: string | null;
  reminded_1_at: string | null;
  reminded_expired_at: string | null;
}

const REMINDER_PAGE = 500;
const REMINDER_MAX_PAGES = 200;

/**
 * Push each rider whose document expires in 30, 7 or 1 days, or has expired —
 * once per stage — and mark expired documents `expired`. Returns how many
 * reminders were claimed (and so pushed).
 *
 * At most once: a reminder is CLAIMED by a conditional update (`… where
 * <stamp> is null`) before the push is sent, so two overlapping runs cannot
 * both send it; a push that then fails is not retried (a missed nudge, not a
 * missed payment). Pushes are best-effort and never stop the run.
 */
export async function sendDocumentExpiryReminders(
  now: Date = new Date(),
  opts: { push?: (driverId: string, doc: { type: string; daysLeft: number }) => Promise<unknown> } = {}
): Promise<number> {
  const push = opts.push ?? notifyRiderDocumentExpiring;
  const today = istDay(now);
  const horizon = reminderHorizon(today);
  const supabase = createAdminClient();
  const stampedAt = now.toISOString();
  let sent = 0;
  let after = "";

  for (let page = 0; page < REMINDER_MAX_PAGES; page++) {
    let q = supabase
      .from("rider_documents")
      .select("id, driver_id, doc_type, expires_on, status, reminded_30_at, reminded_7_at, reminded_1_at, reminded_expired_at")
      .in("status", ["pending", "verified", "expired"])
      .lte("expires_on", horizon)
      .is("reminded_expired_at", null);
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id").limit(REMINDER_PAGE).overrideTypes<ReminderRow[]>();
    if (error) fail(error);
    const rows = data ?? [];

    for (const row of rows) {
      const stage = reminderStage(
        {
          expiresOn: row.expires_on,
          status: row.status,
          reminded30: row.reminded_30_at !== null,
          reminded7: row.reminded_7_at !== null,
          reminded1: row.reminded_1_at !== null,
          remindedExpired: row.reminded_expired_at !== null,
        },
        today
      );
      if (!stage) continue;
      const claim: Record<string, unknown> = {};
      // Earlier stamps keep their own time; only the unset ones are written.
      for (const s of stage.stamps) if (row[s] === null) claim[s] = stampedAt;
      if (stage.stage === "expired" && row.status !== "expired") claim.status = "expired";
      const own = stage.stamps[stage.stamps.length - 1];
      const { data: claimed, error: claimError } = await supabase
        .from("rider_documents")
        .update(claim)
        .eq("id", row.id)
        .is(own, null)
        .in("status", ["pending", "verified", "expired"])
        .select("id")
        .overrideTypes<{ id: string }[]>();
      if (claimError) {
        captureError(claimError, { source: "rider-documents/reminders", driverId: row.driver_id, attrs: { event: "reminder_claim_failed" } });
        continue;
      }
      if (!claimed || claimed.length === 0) continue;
      sent++;
      try {
        await push(row.driver_id, { type: row.doc_type, daysLeft: stage.daysLeft });
      } catch (e) {
        captureError(e, { source: "rider-documents/reminders", driverId: row.driver_id, attrs: { event: "reminder_push_failed", documentId: row.id } });
      }
    }
    if (rows.length < REMINDER_PAGE) break;
    after = rows[rows.length - 1].id;
  }
  return sent;
}
