import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { categoryLabel } from "@/lib/support/rules";
import { notifyStaff } from "./ops-notify";

/**
 * Tell the staff a ticket was escalated — one rule for the Manager app and the
 * admin support desk (review #24: the desk escalated without telling anyone).
 * Level 1 goes to the zone's support managers; level 2 and up to every admin as
 * well. The text carries the ticket number, its category and the level — never
 * its subject or the staff reason (free text); the thread has both.
 * Never throws.
 */
export async function notifyTicketEscalated(ticketId: string, level?: number): Promise<void> {
  try {
    const { data } = await createAdminClient()
      .from("support_tickets")
      .select("id, number, category, zone_id, escalation_level")
      .eq("id", ticketId)
      .maybeSingle();
    const t = data as { id: string; number: number; category: string; zone_id: string | null; escalation_level: number | null } | null;
    if (!t) return;
    const lvl = level ?? Math.max(1, Number(t.escalation_level ?? 1));
    await notifyStaff(
      { zoneId: t.zone_id, kind: "ticket_activity", permission: "manager.support.manage", managersOnly: lvl < 2 },
      { title: `Ticket #${Number(t.number)} escalated to level ${lvl}`, body: `${categoryLabel(t.category)} ticket. Open it to see why.` },
      { url: `/more/tickets/${t.id}`, ticketId: t.id }
    );
  } catch {
    // an escalation notice must never break the escalation
  }
}
