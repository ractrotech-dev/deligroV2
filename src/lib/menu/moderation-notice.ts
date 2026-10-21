import { formatINR } from "@/lib/utils/format";

/**
 * The line a shop sees on its own dish about Deligro's moderation (0146).
 * Pure; `approvalStatus: "unknown"` means the state could not be read, which
 * is said plainly rather than shown as approved.
 */
export interface ModerationNotice {
  tone: "pending" | "critical" | "neutral";
  label: string;
  detail: string;
}

export function moderationNotice(item: {
  price: number;
  approvalStatus: "approved" | "pending" | "rejected" | "unknown";
  pendingPrice: number | null;
  hidden: boolean;
  hiddenReason: string | null;
  approvalNote: string | null;
}): ModerationNotice | null {
  if (item.hidden) {
    return {
      tone: "critical",
      label: "Hidden by Deligro",
      detail: `Customers can't see this dish. ${item.hiddenReason ?? "Contact Deligro to find out why."}`,
    };
  }
  switch (item.approvalStatus) {
    case "approved":
      return null;
    case "unknown":
      return { tone: "neutral", label: "Status unavailable", detail: "Couldn't load whether Deligro has approved this dish. Refresh to try again." };
    case "rejected":
      return {
        tone: "critical",
        label: "Not approved",
        detail: `${item.approvalNote ? `Deligro: ${item.approvalNote}. ` : ""}Edit the dish to send it for approval again.`,
      };
    case "pending":
      if (item.pendingPrice !== null) {
        return {
          tone: "pending",
          label: "New price waiting for approval",
          detail: `Customers pay ${formatINR(item.price)} until Deligro approves ${formatINR(item.pendingPrice)}.`,
        };
      }
      return {
        tone: "pending",
        label: "Waiting for approval",
        detail: `This dish is not on sale until Deligro approves it.${item.approvalNote ? ` ${item.approvalNote}.` : ""}`,
      };
  }
}
