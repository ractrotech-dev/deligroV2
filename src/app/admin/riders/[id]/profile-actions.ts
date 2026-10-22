"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyRiderProfileDecision } from "@/lib/notifications/order-events";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { decideChangeRequest, reviewDocument, setVerification } from "@/lib/data-access/admin-rider-profile";
import { setPayoutAccountByAdmin } from "@/lib/data-access/rider-payout-accounts";
import {
  adminProfileError,
  parseChangeDecision,
  parseDocumentReview,
  parsePayoutEdit,
  parseVerificationDecision,
} from "@/lib/rider/admin-profile";
import { DOC_TYPE_LABEL, maskPayoutAccount, type RiderDocType } from "@/lib/rider/profile-rules";
import type { ActionResult } from "@/lib/rider/admin-money";

/**
 * The rider Profile and Documents tabs' decisions (Phase 6 Task 3).
 *
 * Each is a public HTTP endpoint (AGENTS.md rule 3): the first statement is
 * `requireRole("admin")`, the second a rate limit. The writes run on the
 * service-role client inside `admin-rider-profile.ts` /
 * `rider-payout-accounts.ts` (the 0086 tables have no write policy for anyone
 * signed in), so that role check is what stands in front of them (rule 5), and
 * the admin recorded as reviewer / verifier / decider is the session's own id,
 * never a form field. Every decision pushes the rider.
 */

const fail = (code: string): ActionResult => ({ ok: false, error: adminProfileError(code) });

function refresh(driverId: string): void {
  revalidatePath(`/admin/riders/${driverId}`);
  revalidatePath("/admin/riders");
}

function unexpected(e: unknown, event: string, driverId: string): ActionResult {
  if (isRiderSchemaPending(e)) return fail("migration_pending");
  captureError(e, { source: "admin-riders/profile", attrs: { event, driverId } });
  return fail("failed");
}

const docLabel = (t: string) => DOC_TYPE_LABEL[t as RiderDocType] ?? "Document";

async function review(form: FormData, decision: "verify" | "reject", adminId: string): Promise<ActionResult> {
  if (!isSupabaseConfigured) return fail("demo");
  const parsed = parseDocumentReview(form, decision);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { driverId, documentId, remarks } = parsed.value;
  try {
    const r = await reviewDocument(adminId, driverId, documentId, decision, remarks);
    if (!r.ok) return fail(r.error);
    deferNotify(() =>
      notifyRiderProfileDecision(driverId, { kind: "document", docType: r.docType, status: decision === "verify" ? "verified" : "rejected", note: remarks })
    );
    refresh(driverId);
    return { ok: true, message: `${docLabel(r.docType)} ${decision === "verify" ? "verified" : "rejected"}. The rider has been told.` };
  } catch (e) {
    return unexpected(e, "document_review_failed", driverId);
  }
}

/** Mark one pending document verified. */
export async function verifyDocumentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-profile-admin:${admin.id}`, 30, 60_000);
  if (!limit.ok) return fail("too_fast");
  return review(form, "verify", admin.id);
}

/** Reject one pending document, with remarks the rider reads. */
export async function rejectDocumentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-profile-admin:${admin.id}`, 30, 60_000);
  if (!limit.ok) return fail("too_fast");
  return review(form, "reject", admin.id);
}

/** Verify or reject the rider overall. */
export async function setVerificationAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-profile-admin:${admin.id}`, 30, 60_000);
  if (!limit.ok) return fail("too_fast");
  if (!isSupabaseConfigured) return fail("demo");
  const parsed = parseVerificationDecision(form);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const input = parsed.value;
  try {
    const r = await setVerification(admin.id, input);
    if (!r.ok) {
      if (r.error === "documents_unverified" && r.missing?.length) {
        return {
          ok: false,
          error: `Still to verify: ${r.missing.map(docLabel).join(", ")}. Verify them first, or tick the override and say why.`,
        };
      }
      return fail(r.error);
    }
    deferNotify(() => notifyRiderProfileDecision(input.driverId, { kind: "verification", status: r.status, note: input.note }));
    refresh(input.driverId);
    return {
      ok: true,
      message: r.status === "verified" ? "Rider verified. They have been told." : "Rider rejected and taken offline. They have been told.",
    };
  } catch (e) {
    return unexpected(e, "verification_failed", input.driverId);
  }
}

/** Approve (apply) or reject a rider's change request. */
export async function decideChangeRequestAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-profile-admin:${admin.id}`, 30, 60_000);
  if (!limit.ok) return fail("too_fast");
  if (!isSupabaseConfigured) return fail("demo");
  const parsed = parseChangeDecision(form);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { driverId, requestId, decision, note } = parsed.value;
  try {
    const r = await decideChangeRequest(admin.id, driverId, requestId, decision, note);
    if (!r.ok) return fail(r.error);
    deferNotify(() => notifyRiderProfileDecision(driverId, { kind: "change", field: r.field, status: r.status, note }));
    refresh(driverId);
    return { ok: true, message: r.status === "approved" ? "Approved and saved to the profile. The rider has been told." : "Rejected. The rider has been told." };
  } catch (e) {
    return unexpected(e, "change_decision_failed", driverId);
  }
}

/** Set the rider's payout account directly (they gave it to the desk). */
export async function editPayoutAccountAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-payout-account:${admin.id}`, 10, 60_000);
  if (!limit.ok) return fail("too_fast");
  if (!isSupabaseConfigured) return fail("demo");
  const parsed = parsePayoutEdit(form);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { driverId, account } = parsed.value;
  try {
    await setPayoutAccountByAdmin(driverId, account, admin.id);
    deferNotify(() =>
      notifyRiderProfileDecision(driverId, { kind: "change", field: "payout_account", status: "approved", note: "Updated by Deligro." })
    );
    refresh(driverId);
    const masked = maskPayoutAccount({
      kind: account.kind,
      accountNumber: account.kind === "bank" ? account.accountNumber : null,
      upiId: account.kind === "upi" ? account.upiId : null,
    });
    return { ok: true, message: `Payout account saved (${masked}). The rider has been told.` };
  } catch (e) {
    return unexpected(e, "payout_account_failed", driverId);
  }
}
