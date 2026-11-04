import type { Tone } from "@/components/admin/console";
import type { SettlementStatus } from "@/lib/data-access/admin-settlements";

/** How a payment's status reads on every screen that lists one. */
export const PAYMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: "Not finished",
  paid: "Paid",
  void: "Cancelled",
};

export const PAYMENT_STATUS_TONE: Record<SettlementStatus, Tone> = {
  draft: "amber",
  paid: "green",
  void: "neutral",
};
