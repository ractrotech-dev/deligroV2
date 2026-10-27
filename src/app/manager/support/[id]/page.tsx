import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { getTicketForStaff } from "@/lib/data-access/support";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { isUuid, managerMaySeeTicket } from "@/lib/support/rules";
import { ThreadView } from "@/app/admin/support/thread-view";

export const metadata: Metadata = { title: "Ticket · Manager · Deligro" };

/**
 * Manager → one rider emergency or delivery ticket, read-only: the facts, the
 * thread and a call button. Opened from the emergency banner on the board and
 * from the SOS ring push (`/manager/support/<ticketId>`).
 *
 * A manager reads what the RLS lets them read — rider tickets that are
 * emergencies or about a delivery (`managerMaySeeTicket`, the same rule as
 * `is_rider_ops_ticket`), in one of their own zones (0143's zone read, which
 * replaced 0087's every-manager read); anything else is a 404, the same as a
 * missing ticket. This page reads with the service role, so both rules are
 * applied here explicitly. Replies and status changes are the admin support
 * desk's.
 *
 * Platform: BOTH.
 */
export const dynamic = "force-dynamic";

export default async function ManagerTicketPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const staff = await requireRole(["manager", "admin"]);
  const { id } = await params;
  if (!isUuid(id) || !isSupabaseConfigured) notFound();
  // The rule is applied on the ticket row before any message is read or any
  // photo URL signed.
  const scope = await staffScopeFor(staff);
  const thread = await getTicketForStaff(id, staff.role === "admin" ? {} : { allow: managerMaySeeTicket, scope });
  if (!thread) notFound();

  // The same switch that hides riders' numbers on the board.
  const canCall = staff.role === "admin" || (await staffFeatureOn("manager.call_customer"));
  return (
    <ThreadView
      thread={thread}
      back={{ href: "/manager", label: "Board" }}
      canCall={canCall}
      actions={
        <p className="text-[12.5px] text-muted">
          Replies and status changes are made on the admin support desk.
          {staff.role === "admin" ? (
            <>
              {" "}
              <Link href={`/admin/support/${thread.ticket.id}`} className="font-semibold text-accent-ink hover:underline">
                Open it there
              </Link>
              .
            </>
          ) : null}
        </p>
      }
    />
  );
}
