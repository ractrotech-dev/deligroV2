"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { assignTicketToSelf, setTicketStatus, staffReply } from "@/lib/data-access/support";
import { deskError, replyFromForm } from "@/lib/support/admin-forms";
import { isTicketStatus, isUuid } from "@/lib/support/rules";

/**
 * The support desk's three writes: answer (or leave an internal note),
 * change the status, take the ticket. Each starts with the admin gate and a
 * rate limit (AGENTS.md rules 3 and 6); the data layer writes with the
 * service role only after that, pushes the requester (`support`) on a public
 * reply or a status change, and stops every ops phone ringing when an
 * emergency is first acted on.
 */

export type DeskResult = { ok: true; message?: string } | { ok: false; error: string };

const DEMO = "Demo mode: connect Supabase to answer tickets. Nothing was saved.";
const TOO_FAST = "Too many changes in a minute. Wait a moment and try again.";
const PENDING = "Support tickets need migration 0087 applied to this database.";

function refresh(id: string): void {
  revalidatePath("/admin/support");
  revalidatePath(`/admin/support/${id}`);
}

function failure(e: unknown, event: string): DeskResult {
  if (isRiderSchemaPending(e)) return { ok: false, error: PENDING };
  captureError(e, { source: "admin-support", attrs: { event } });
  return { ok: false, error: "That didn't save. Try again." };
}

/** Reply to the requester (pushed to them), or an internal note (seen by staff only). */
export async function replyTicketAction(id: string, _prev: DeskResult | null, form: FormData): Promise<DeskResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-support:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!isUuid(id)) return { ok: false, error: deskError("not_found") };

  const parsed = replyFromForm(form);
  if (!parsed.ok) return { ok: false, error: deskError(parsed.error) };
  try {
    const r = await staffReply(id, { id: admin.id, role: "admin" }, parsed.value);
    if (!r.ok) return { ok: false, error: deskError(r.error) };
  } catch (e) {
    return failure(e, "ticket_reply_failed");
  }
  refresh(id);
  return { ok: true, message: parsed.value.internal ? "Note saved. The requester does not see it." : "Reply sent." };
}

/** Move the status on; the requester is told. */
export async function setTicketStatusAction(id: string, status: string, resolution?: string): Promise<DeskResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-support:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!isUuid(id) || !isTicketStatus(status)) return { ok: false, error: deskError("invalid_status") };
  try {
    const words = typeof resolution === "string" ? resolution.trim() : "";
    if (words && (Array.from(words).length < 3 || Array.from(words).length > 1000)) return { ok: false, error: deskError("invalid_resolution") };
    const r = await setTicketStatus(id, status, { id: admin.id, role: "admin" }, { resolution: words || null });
    if (!r.ok) return { ok: false, error: deskError(r.error) };
  } catch (e) {
    return failure(e, "ticket_status_failed");
  }
  refresh(id);
  return { ok: true, message: "Status changed. The requester has been told." };
}

/** "I've got this" — assign to me; an open ticket becomes in progress. */
export async function assignTicketAction(id: string): Promise<DeskResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-support:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!isUuid(id)) return { ok: false, error: deskError("not_found") };
  try {
    const r = await assignTicketToSelf(id, { id: admin.id, role: "admin" });
    if (!r.ok) return { ok: false, error: deskError(r.error) };
  } catch (e) {
    return failure(e, "ticket_assign_failed");
  }
  refresh(id);
  return { ok: true, message: "Assigned to you." };
}
