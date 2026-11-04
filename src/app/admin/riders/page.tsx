import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { listRidersForAdmin, type AdminRiderRow } from "@/lib/data-access/admin-riders";
import { listReviewFlags, type ReviewFlags } from "@/lib/data-access/admin-rider-profile";
import { listEmployees, listStaffLoginEmails } from "@/lib/data-access/employees";
import { RidersView, type RidersSearch } from "./riders-view";

export const metadata: Metadata = { title: "Riders · Admin · Deligro" };

/**
 * Admin → Riders. Everyone with a driver login, with where they stand right
 * now (online, on a break, online but with no recent position, offline), the
 * order they are carrying, today's deliveries and what they are owed.
 *
 * Documents (0086): one column for verification and documents expiring within
 * 30 days; "Documents to check" lists riders with a pending verification,
 * document or change request, or an expiring document. Before 0086 the column
 * shows a dash and the filter is not offered.
 *
 * "To pay" is the rider's unsettled balance from the 0083 ledger. Before that
 * migration is applied there IS no ledger, so the column shows a dash - never
 * ₹0, which would be a statement about a rider's pay that nothing backs.
 *
 * Add rider and each row's Account dialog use the same actions as Settings → Team,
 * which check the role themselves. Passwords can't be shown (AGENTS.md rule 4).
 */
export const dynamic = "force-dynamic";

export default async function AdminRidersPage({ searchParams }: Readonly<{ searchParams: Promise<RidersSearch> }>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  let riders: AdminRiderRow[] = [];
  let flags: Record<string, ReviewFlags> = {};
  let logins: Record<string, string> = {};
  let stopped: string[] = [];
  let failed = false;
  if (isSupabaseConfigured) {
    try {
      const [list, review] = await Promise.all([listRidersForAdmin(), listReviewFlags()]);
      riders = list;
      flags = Object.fromEntries(review);
      // A failure here costs the login line and the Deactivated label, not the list.
      const [emails, staff] = await Promise.all([
        listStaffLoginEmails(list.map((r) => r.id)).catch(() => new Map<string, string>()),
        listEmployees().catch(() => []),
      ]);
      logins = Object.fromEntries(emails);
      stopped = staff.filter((s) => s.stopped).map((s) => s.id);
    } catch (e) {
      failed = true;
      captureError(e, { source: "admin-riders/list", attrs: { event: "riders_list_failed" } });
    }
  }

  return <RidersView riders={riders} sp={sp} failed={failed} flags={flags} logins={logins} stopped={stopped} canAdd={isSupabaseConfigured} />;
}
