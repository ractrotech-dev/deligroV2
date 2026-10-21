import type { Tone } from "@/components/admin/console";
import type { TicketStatus } from "@/lib/vendor/growth-input";

export const TICKET_TONE: Record<TicketStatus, Tone> = {
  open: "amber",
  in_progress: "blue",
  waiting_on_requester: "accent",
  resolved: "green",
  closed: "neutral",
};
