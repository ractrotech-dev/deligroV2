import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { listAnnouncements, type AdminAnnouncement } from "@/lib/data-access/announcements";
import { AnnouncementsView } from "./announcements-view";

export const metadata: Metadata = { title: "Announcements · Admin · Deligro" };

/**
 * Admin → Announcements: the composer (audience, message, IST schedule, push
 * now, a preview of the inbox card) and every announcement sent or scheduled.
 * Publishing one that starts now fans out through `notifyUser` with category
 * `announcements`. English only.
 *
 * Platform: BOTH.
 */
export const dynamic = "force-dynamic";

export default async function AdminAnnouncementsPage() {
  // The layout is not a guard: the page that reads service-role data checks for itself.
  await requireRole("admin");
  let list: AdminAnnouncement[] = [];
  let pending = false;
  if (isSupabaseConfigured) {
    try {
      list = await listAnnouncements();
    } catch (e) {
      pending = true;
      captureError(e, { source: "admin-announcements/list", attrs: { event: "announcements_list_failed" } });
    }
  }
  return <AnnouncementsView list={list} pending={pending} />;
}
