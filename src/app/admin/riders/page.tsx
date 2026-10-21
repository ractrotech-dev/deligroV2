import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { listRidersForAdmin, type AdminRiderRow } from "@/lib/data-access/admin-riders";
import { RidersView, type RidersSearch } from "./riders-view";

export const metadata: Metadata = { title: "Riders · Admin · Deligro" };

/**
 * Admin → Riders. Everyone with a driver login, with where they stand right
 * now (online, on a break, online but with no recent position, offline), the
 * order they are carrying, today's deliveries and what they are owed.
 *
 * Platform: BOTH. One page, a real table in the console and stacked cards in
 * the phone frame (DataTable's container query). Read-only; the money lives on
 * the rider's own page (Money tab).
 *
 * "Owed" is the rider's unsettled balance from the 0083 ledger. Before that
 * migration is applied there IS no ledger, so the column shows a dash - never
 * ₹0, which would be a statement about a rider's pay that nothing backs.
 */
export const dynamic = "force-dynamic";

export default async function AdminRidersPage({ searchParams }: Readonly<{ searchParams: Promise<RidersSearch> }>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  let riders: AdminRiderRow[] = [];
  let failed = false;
  if (isSupabaseConfigured) {
    try {
      riders = await listRidersForAdmin();
    } catch (e) {
      failed = true;
      captureError(e, { source: "admin-riders/list", attrs: { event: "riders_list_failed" } });
    }
  }

  return <RidersView riders={riders} sp={sp} failed={failed} />;
}
