import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { listTicketsForStaff, type StaffTicketRow } from "@/lib/data-access/support";
import { listEmergenciesAction } from "@/app/manager/support-actions";
import type { EmergencyItem } from "@/components/ops/emergency-types";
import { parseTicketFilter } from "@/lib/support/rules";
import { SupportView } from "./support-view";

export const metadata: Metadata = { title: "Support · Admin · Deligro" };

/**
 * Admin → Support: every ticket and incident from riders and shops (the
 * shared 0064/0087 tables). Filters by who raised it, category, priority and
 * status; open emergencies are pinned on top and red, and the live emergency
 * banner (which polls and can sound) sits above the list.
 *
 * Platform: BOTH. A `DataTable` at a desk, stacked cards in the phone frame;
 * the filters are a GET form, so a filtered view survives a reload.
 */
export const dynamic = "force-dynamic";

export default async function AdminSupportPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | undefined>> }>) {
  // The layout is not a guard: the page that reads service-role data checks for itself.
  await requireRole("admin");

  const filter = parseTicketFilter(await searchParams);
  let tickets: StaffTicketRow[] = [];
  let emergencies: EmergencyItem[] = [];
  let pending = false;
  if (isSupabaseConfigured) {
    try {
      [tickets, emergencies] = await Promise.all([listTicketsForStaff(filter), listEmergenciesAction()]);
    } catch (e) {
      if (isRiderSchemaPending(e)) pending = true;
      else {
        captureError(e, { source: "admin-support/list", attrs: { event: "support_list_failed" } });
        throw e;
      }
    }
  }
  return <SupportView tickets={tickets} emergencies={emergencies} filter={filter} pending={pending} />;
}
