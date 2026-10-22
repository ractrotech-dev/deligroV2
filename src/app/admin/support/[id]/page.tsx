import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getTicketForStaff } from "@/lib/data-access/support";
import { isUuid } from "@/lib/support/rules";
import { TicketReplyForm } from "../reply-form";
import { ThreadView } from "../thread-view";

export const metadata: Metadata = { title: "Ticket · Support · Admin · Deligro" };

/**
 * Admin → Support → one ticket: the facts (who, order, location, assignee),
 * the whole thread with internal notes marked and photos through 10-minute
 * signed URLs, and the reply form (public reply or internal note, status,
 * assign to me, resolve, close).
 *
 * Platform: BOTH — the thread and the facts stack in the phone frame and sit
 * side by side at a desk.
 */
export const dynamic = "force-dynamic";

export default async function AdminTicketPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const admin = await requireRole("admin");
  const { id } = await params;
  if (!isUuid(id) || !isSupabaseConfigured) notFound();
  const thread = await getTicketForStaff(id);
  if (!thread) notFound();

  const role = thread.ticket.requesterRole === "rider" ? "the rider" : thread.ticket.requesterRole === "vendor" ? "the shop" : "them";
  return (
    <ThreadView
      thread={thread}
      back={{ href: "/admin/support", label: "Support" }}
      canCall
      actions={
        <TicketReplyForm
          id={thread.ticket.id}
          status={thread.ticket.status}
          assignedToYou={thread.ticket.assignedTo === admin.id}
          requesterLabel={role}
        />
      }
    />
  );
}
