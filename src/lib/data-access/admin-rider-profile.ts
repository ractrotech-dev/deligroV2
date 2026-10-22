import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import {
  RiderSchemaPendingError,
  forceRiderOffline,
  getActiveDeliveryId,
  isRiderSchemaPending,
} from "@/lib/data-access/rider-status";
import { SIGNED_URL_SECONDS } from "@/lib/data-access/rider-profile";
import {
  getPayoutAccountForAdmin,
  getStagedPayoutAccountForAdmin,
  type AdminPayoutView,
  type PayoutAccount,
} from "@/lib/data-access/rider-payout-accounts";
import { istDay } from "@/lib/rider/earnings-math";
import {
  VEHICLE_TYPE_LABEL,
  daysUntil,
  documentsStatus,
  isVerification,
  reminderHorizon,
  type DocumentsStatus,
  type VehicleType,
  type Verification,
} from "@/lib/rider/profile-rules";
import { unverifiedRequired, verificationTarget } from "@/lib/rider/admin-profile";

/**
 * The admin console's rider Profile and Documents tabs, the Riders list's
 * review flags, and the decisions behind them (Phase 6 Task 3).
 *
 * ## Authorization
 *
 * Everything runs on the service-role client: the 0086 tables have no write
 * policy for anyone signed in, the raw document numbers are not granted to any
 * client, and payout details live in the contained tables. So every function
 * is the caller's to guard: each page, route and server action that reaches
 * this module has run `requireRole("admin")` first (AGENTS.md rule 5), and the
 * admin id passed in is that session's — recorded as `reviewed_by`,
 * `verified_by`, `decided_by`, `updated_by`, never a form value.
 *
 * ## The same database effects as the Manager app
 *
 * The Manager branch decides the same things through audited RPCs
 * (`ops_review_rider_document`, `ops_set_rider_verification`, 0151). These
 * writes leave the same columns: a document goes pending → verified |
 * rejected with `remarks`, `reviewed_by`, `reviewed_at`; verification follows
 * the same transitions and required-documents rule (`lib/rider/admin-profile.ts`),
 * sets `verified_at` / `verified_by` only on verify, refuses a rejection while
 * the rider carries an order and takes a rejected rider offline. Every write is
 * conditional on the state the admin saw, so two people deciding at once
 * cannot both succeed.
 */

type PgError = { code?: string; message?: string };
const PENDING_MESSAGE = "migration_pending: rider profile and documents (0086) are not applied";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = "rider-documents";

function fail(error: PgError): never {
  if (isMissingTable(error) || isMissingColumn(error) || error.code === "PGRST202") {
    throw new RiderSchemaPendingError(PENDING_MESSAGE);
  }
  throw error;
}

const verificationOf = (v: string | null | undefined): Verification => (isVerification(v) ? v : "unverified");

// ---------------------------------------------------------------------------
// the Profile and Documents tabs
// ---------------------------------------------------------------------------

export interface AdminDocument {
  id: string;
  type: string;
  /** In full for PAN, licence, RC; null for Aadhaar (never stored) and photos. */
  number: string | null;
  numberMasked: string | null;
  expiresOn: string | null;
  daysLeft: number | null;
  status: string;
  remarks: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  uploadedAt: string;
  kind: "pdf" | "image";
  /** A 10-minute signed link made when the page rendered (live documents only). */
  viewUrl: string | null;
}

export interface AdminChange {
  id: string;
  field: string;
  createdAt: string;
  /** What is on file now, in full (admins only). */
  current: string;
  /** What the rider asked for, in full. */
  proposed: string;
}

export interface AdminRiderProfile {
  driverId: string;
  name: string | null;
  riderCode: string | null;
  verification: Verification;
  verifiedAt: string | null;
  verifiedBy: string | null;
  address: { line: string | null; city: string | null; pincode: string | null };
  vehicle: { type: string | null; owner: "deligro" | "rider"; registration: string | null };
  licence: { number: string | null; expiresOn: string | null };
  emergency: { name: string | null; phone: string | null; relation: string | null };
  documents: AdminDocument[];
  /** Replaced documents, newest first (the last 10). */
  history: AdminDocument[];
  documentsStatus: DocumentsStatus;
  changes: AdminChange[];
  payout: AdminPayoutView;
}

interface ProfileRow {
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
  verified_by: string | null;
}

interface DocRow {
  id: string;
  doc_type: string;
  number: string | null;
  number_masked: string | null;
  file_path: string;
  expires_on: string | null;
  status: string;
  remarks: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

function describeAccount(a: PayoutAccount | null): string {
  if (!a) return "None on file";
  return a.kind === "bank"
    ? ["Bank", a.holderName, a.accountNumber, a.ifsc].filter(Boolean).join(" · ")
    : ["UPI", a.upiId, a.holderName].filter(Boolean).join(" · ");
}

function describeVehicle(type: unknown, owner: unknown, registration: unknown): string {
  const t = typeof type === "string" && type in VEHICLE_TYPE_LABEL ? VEHICLE_TYPE_LABEL[type as VehicleType] : "Not set";
  const o = owner === "rider" ? "rider's own" : owner === "deligro" ? "Deligro's" : null;
  return [t, typeof registration === "string" && registration ? registration : null, o].filter(Boolean).join(" · ");
}

function describeLicence(number: unknown, expiresOn: unknown): string {
  const n = typeof number === "string" && number ? number : "No number";
  return typeof expiresOn === "string" && expiresOn ? `${n} · valid to ${expiresOn}` : n;
}

/** The rider's whole profile for the admin, with the payout account in full. Null when no such rider. */
export async function getRiderProfileForAdmin(driverId: string, now: Date = new Date()): Promise<AdminRiderProfile | null> {
  if (!UUID.test(driverId)) return null;
  const supabase = createAdminClient();
  const today = istDay(now);
  const [person, row, docs, changes] = await Promise.all([
    supabase.from("profiles").select("full_name, role").eq("id", driverId).maybeSingle().overrideTypes<{ full_name: string | null; role: string }>(),
    supabase
      .from("rider_profiles")
      .select(
        "rider_code, address_line, city, pincode, vehicle_type, vehicle_owner, vehicle_registration, licence_number, licence_expires_on, " +
          "emergency_name, emergency_phone, emergency_relation, verification_status, verified_at, verified_by"
      )
      .eq("driver_id", driverId)
      .maybeSingle()
      .overrideTypes<ProfileRow>(),
    supabase
      .from("rider_documents")
      .select("id, doc_type, number, number_masked, file_path, expires_on, status, remarks, reviewed_by, reviewed_at, created_at")
      .eq("driver_id", driverId)
      .order("created_at", { ascending: false })
      .limit(60)
      .overrideTypes<DocRow[]>(),
    supabase
      .from("rider_profile_change_requests")
      .select("id, field, new_value, created_at")
      .eq("driver_id", driverId)
      .eq("status", "pending")
      .order("created_at")
      .overrideTypes<{ id: string; field: string; new_value: Record<string, unknown> | null; created_at: string }[]>(),
  ]);
  if (person.error) throw person.error;
  if (!person.data || person.data.role !== "driver") return null;
  if (row.error) fail(row.error);
  if (docs.error) fail(docs.error);
  if (changes.error) fail(changes.error);
  const p = row.data;
  const payout = await getPayoutAccountForAdmin(driverId);

  // Names for reviewer / verifier ids.
  const staffIds = [...new Set([p?.verified_by, ...(docs.data ?? []).map((d) => d.reviewed_by)].filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data } = await supabase.from("profiles").select("id, full_name").in("id", staffIds).overrideTypes<{ id: string; full_name: string | null }[]>();
    for (const s of data ?? []) names.set(s.id, s.full_name?.trim() || "Staff");
  }

  const live = (docs.data ?? []).filter((d) => d.status !== "replaced");
  const replaced = (docs.data ?? []).filter((d) => d.status === "replaced").slice(0, 10);
  const signed = new Map<string, string>();
  if (live.length > 0) {
    const { data: urls } = await supabase.storage.from(BUCKET).createSignedUrls(
      live.map((d) => d.file_path),
      SIGNED_URL_SECONDS
    );
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
  }
  const toDoc = (d: DocRow, withUrl: boolean): AdminDocument => ({
    id: d.id,
    type: d.doc_type,
    number: d.doc_type === "aadhaar" ? null : d.number,
    numberMasked: d.number_masked,
    expiresOn: d.expires_on,
    daysLeft: d.expires_on ? daysUntil(d.expires_on, today) : null,
    status: d.status,
    remarks: d.remarks,
    reviewedAt: d.reviewed_at,
    reviewedBy: d.reviewed_by ? (names.get(d.reviewed_by) ?? "Staff") : null,
    uploadedAt: d.created_at,
    kind: /\.pdf$/i.test(d.file_path) ? "pdf" : "image",
    viewUrl: withUrl ? (signed.get(d.file_path) ?? null) : null,
  });
  const documents = live.map((d) => toDoc(d, true));

  const adminChanges: AdminChange[] = [];
  for (const c of changes.data ?? []) {
    const v = c.new_value ?? {};
    let current = "";
    let proposed = "";
    if (c.field === "full_name") {
      current = person.data.full_name?.trim() || "No name";
      proposed = typeof v.fullName === "string" ? v.fullName : "";
    } else if (c.field === "licence") {
      current = describeLicence(p?.licence_number, p?.licence_expires_on);
      proposed = describeLicence(v.number, v.expiresOn);
    } else if (c.field === "vehicle") {
      current = describeVehicle(p?.vehicle_type, p?.vehicle_owner, p?.vehicle_registration);
      proposed = describeVehicle(v.type, v.owner, v.registration);
    } else if (c.field === "payout_account") {
      current = describeAccount(payout.account);
      const staged =
        payout.pending?.requestId === c.id
          ? payout.pending
          : typeof v.stagedId === "string"
            ? await getStagedPayoutAccountForAdmin(driverId, v.stagedId)
            : null;
      proposed = staged ? describeAccount(staged) : "Missing — reject and ask the rider to send it again";
    }
    adminChanges.push({ id: c.id, field: c.field, createdAt: c.created_at, current, proposed });
  }

  const owner = p?.vehicle_owner === "rider" ? "rider" : "deligro";
  return {
    driverId,
    name: person.data.full_name?.trim() || null,
    riderCode: p?.rider_code ?? null,
    verification: verificationOf(p?.verification_status),
    verifiedAt: p?.verified_at ?? null,
    verifiedBy: p?.verified_by ? (names.get(p.verified_by) ?? "Staff") : null,
    address: { line: p?.address_line ?? null, city: p?.city ?? null, pincode: p?.pincode ?? null },
    vehicle: { type: p?.vehicle_type ?? null, owner, registration: p?.vehicle_registration ?? null },
    licence: { number: p?.licence_number ?? null, expiresOn: p?.licence_expires_on ?? null },
    emergency: { name: p?.emergency_name ?? null, phone: p?.emergency_phone ?? null, relation: p?.emergency_relation ?? null },
    documents,
    history: replaced.map((d) => toDoc(d, false)),
    documentsStatus: documentsStatus(
      documents.map((d) => ({ type: d.type, status: d.status, expiresOn: d.expiresOn })),
      owner,
      today
    ),
    changes: adminChanges,
    payout,
  };
}

/** A fresh 10-minute link to any of this rider's documents (history included); null if not theirs. */
export async function adminDocumentUrl(driverId: string, docId: string): Promise<string | null> {
  if (!UUID.test(driverId) || !UUID.test(docId)) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("rider_documents")
    .select("file_path")
    .eq("id", docId)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ file_path: string }>();
  if (error) fail(error);
  if (!data) return null;
  const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(data.file_path, SIGNED_URL_SECONDS);
  if (signError) throw signError;
  return signed?.signedUrl ?? null;
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

/** Verify or reject one PENDING document of this rider. */
export async function reviewDocument(
  adminId: string,
  driverId: string,
  documentId: string,
  decision: "verify" | "reject",
  remarks: string | null,
  now: Date = new Date()
): Promise<{ ok: true; docType: string } | { ok: false; error: "not_found" | "already_decided" }> {
  const supabase = createAdminClient();
  const { data: doc, error } = await supabase
    .from("rider_documents")
    .select("id, doc_type, status")
    .eq("id", documentId)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ id: string; doc_type: string; status: string }>();
  if (error) fail(error);
  if (!doc) return { ok: false, error: "not_found" };
  if (doc.status !== "pending") return { ok: false, error: "already_decided" };
  const { data: hit, error: updateError } = await supabase
    .from("rider_documents")
    .update({
      status: decision === "verify" ? "verified" : "rejected",
      remarks,
      reviewed_by: adminId,
      reviewed_at: now.toISOString(),
    })
    .eq("id", documentId)
    .eq("driver_id", driverId)
    .eq("status", "pending")
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (updateError) fail(updateError);
  if (!hit || hit.length === 0) return { ok: false, error: "already_decided" };
  return { ok: true, docType: doc.doc_type };
}

export type VerificationError = "not_found" | "stale" | "invalid_transition" | "documents_unverified" | "active_delivery";

/** Verify or reject the rider overall (see the module header for the rule). */
export async function setVerification(
  adminId: string,
  input: { driverId: string; decision: "verify" | "reject"; expected: Verification; note: string | null; override: boolean },
  now: Date = new Date()
): Promise<{ ok: true; status: "verified" | "rejected" } | { ok: false; error: VerificationError; missing?: string[] }> {
  const supabase = createAdminClient();
  const { data: row, error } = await supabase
    .from("rider_profiles")
    .select("verification_status")
    .eq("driver_id", input.driverId)
    .maybeSingle()
    .overrideTypes<{ verification_status: string | null }>();
  if (error) fail(error);
  if (!row) return { ok: false, error: "not_found" };
  const current = verificationOf(row.verification_status);
  if (current !== input.expected) return { ok: false, error: "stale" };
  const target = verificationTarget(current, input.decision);
  if (!target) return { ok: false, error: "invalid_transition" };

  if (target === "verified") {
    const { data: docs, error: docsError } = await supabase
      .from("rider_documents")
      .select("doc_type, status, expires_on")
      .eq("driver_id", input.driverId)
      .neq("status", "replaced")
      .overrideTypes<{ doc_type: string; status: string; expires_on: string | null }[]>();
    if (docsError) fail(docsError);
    const missing = unverifiedRequired((docs ?? []).map((d) => ({ type: d.doc_type, status: d.status, expiresOn: d.expires_on })));
    if (missing.length > 0 && !input.override) return { ok: false, error: "documents_unverified", missing };
  } else if ((await getActiveDeliveryId(input.driverId)) !== null) {
    return { ok: false, error: "active_delivery" };
  }

  const update: Record<string, unknown> = { verification_status: target, updated_at: now.toISOString() };
  if (target === "verified") {
    update.verified_at = now.toISOString();
    update.verified_by = adminId;
  }
  const { data: hit, error: updateError } = await supabase
    .from("rider_profiles")
    .update(update)
    .eq("driver_id", input.driverId)
    .eq("verification_status", current)
    .select("driver_id")
    .overrideTypes<{ driver_id: string }[]>();
  if (updateError) fail(updateError);
  if (!hit || hit.length === 0) return { ok: false, error: "stale" };

  if (target === "rejected") {
    try {
      await forceRiderOffline(input.driverId, "ops");
    } catch (e) {
      if (!isRiderSchemaPending(e)) throw e;
    }
  }
  return { ok: true, status: target };
}

/** Approve (apply) or reject one of this rider's pending change requests, as this admin. */
export async function decideChangeRequest(
  adminId: string,
  driverId: string,
  requestId: string,
  decision: "approve" | "reject",
  note: string | null
): Promise<
  | { ok: true; field: string; status: "approved" | "rejected" }
  | { ok: false; error: "not_found" | "already_decided" | "invalid_value" | "staged_missing" }
> {
  const supabase = createAdminClient();
  const { data: req, error } = await supabase
    .from("rider_profile_change_requests")
    .select("id, field")
    .eq("id", requestId)
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<{ id: string; field: string }>();
  if (error) fail(error);
  if (!req) return { ok: false, error: "not_found" };
  const { data, error: rpcError } = await supabase.rpc("rider_decide_change_request", {
    p_request: requestId,
    p_actor: adminId,
    p_decision: decision,
    p_note: note,
  });
  if (rpcError) {
    const m = rpcError.message ?? "";
    if (/already_decided/.test(m)) return { ok: false, error: "already_decided" };
    if (/not_found/.test(m)) return { ok: false, error: "not_found" };
    if (/staged_missing/.test(m)) return { ok: false, error: "staged_missing" };
    if (/invalid_value|reason_required/.test(m) || rpcError.code === "23514") return { ok: false, error: "invalid_value" };
    fail(rpcError);
  }
  const status = (data as { status?: string } | null)?.status === "rejected" ? "rejected" : "approved";
  return { ok: true, field: req.field, status };
}

// ---------------------------------------------------------------------------
// the Riders list
// ---------------------------------------------------------------------------

export interface ReviewFlags {
  verification: Verification;
  pendingDocuments: number;
  pendingChanges: number;
  /** Live documents expiring within 30 days, or already expired. */
  expiringDocuments: number;
  /** Something waits for an admin: pending verification, a pending document or change. */
  needsReview: boolean;
}

const PAGE = 1000;
async function pages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < 100; n++) {
    const { data, error } = await page(n * PAGE, n * PAGE + PAGE - 1);
    if (error) fail(error);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error("review flags read exceeded its page ceiling");
}

/** Per rider: verification, what waits for review, what is expiring. Empty before 0086. */
export async function listReviewFlags(now: Date = new Date()): Promise<Map<string, ReviewFlags>> {
  const out = new Map<string, ReviewFlags>();
  const supabase = createAdminClient();
  const horizon = reminderHorizon(istDay(now));
  try {
    const [profiles, docs, changes] = await Promise.all([
      pages<{ driver_id: string; verification_status: string | null }>((from, to) =>
        supabase.from("rider_profiles").select("driver_id, verification_status").order("driver_id").range(from, to)
      ),
      pages<{ driver_id: string; status: string; expires_on: string | null }>((from, to) =>
        supabase
          .from("rider_documents")
          .select("driver_id, status, expires_on")
          .in("status", ["pending", "verified", "expired"])
          .order("id")
          .range(from, to)
      ),
      pages<{ driver_id: string }>((from, to) =>
        supabase.from("rider_profile_change_requests").select("driver_id").eq("status", "pending").order("id").range(from, to)
      ),
    ]);
    const flag = (id: string, verification: Verification = "unverified"): ReviewFlags => {
      let f = out.get(id);
      if (!f) {
        f = { verification, pendingDocuments: 0, pendingChanges: 0, expiringDocuments: 0, needsReview: false };
        out.set(id, f);
      }
      return f;
    };
    for (const p of profiles) flag(p.driver_id, verificationOf(p.verification_status));
    for (const d of docs) {
      const f = flag(d.driver_id);
      if (d.status === "pending") f.pendingDocuments++;
      if (d.expires_on !== null && d.expires_on <= horizon) f.expiringDocuments++;
    }
    for (const c of changes) flag(c.driver_id).pendingChanges++;
    for (const f of out.values()) f.needsReview = f.verification === "pending" || f.pendingDocuments > 0 || f.pendingChanges > 0;
    return out;
  } catch (e) {
    if (isRiderSchemaPending(e)) return new Map();
    throw e;
  }
}
