"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { createAnnouncement, endAnnouncement } from "@/lib/data-access/announcements";
import { announcementError, announcementFromForm } from "@/lib/support/admin-forms";
import { isUuid } from "@/lib/support/rules";

/**
 * The announcement composer's writes. Admin gate first, then a rate limit;
 * publishing one that starts now fans out through `notifyUsers` (category
 * `announcements`: an inbox row each, and a push unless a rider muted them).
 */

export type ComposerResult = { ok: true; message?: string } | { ok: false; error: string };

const DEMO = "Demo mode: connect Supabase to publish announcements. Nothing was sent.";

export async function createAnnouncementAction(_prev: ComposerResult | null, form: FormData): Promise<ComposerResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-announcements:${admin.id}`, 10, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many announcements in a minute. Wait a moment." };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const parsed = announcementFromForm(form);
  if (!parsed.ok) return { ok: false, error: announcementError(parsed.error) };
  try {
    const { reached } = await createAnnouncement(admin.id, parsed.value);
    revalidatePath("/admin/announcements");
    if (reached > 0) return { ok: true, message: `Published and sent to ${reached} ${reached === 1 ? "person" : "people"}.` };
    return { ok: true, message: parsed.value.startsAt ? "Scheduled. It appears in their inbox when it starts." : "Published." };
  } catch (e) {
    captureError(e, { source: "admin-announcements", attrs: { event: "announcement_failed" } });
    return { ok: false, error: "That didn't publish. If this database has no migration 0087 yet, apply it first." };
  }
}

export async function endAnnouncementAction(id: string): Promise<ComposerResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-announcements:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes in a minute. Wait a moment." };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!isUuid(id)) return { ok: false, error: "That announcement could not be found." };
  try {
    await endAnnouncement(id);
  } catch (e) {
    captureError(e, { source: "admin-announcements", attrs: { event: "announcement_end_failed" } });
    return { ok: false, error: "That didn't save. Try again." };
  }
  revalidatePath("/admin/announcements");
  return { ok: true, message: "Ended." };
}
