import "server-only";
import { notifyShop } from "./notify-user";
import { notifyOpsInZone } from "./order-events";

/**
 * Marketing notices (§8). The shop hears about every decision on its request
 * and when its campaign starts and ends (inbox row + push, category
 * "marketing"); a zone's managers hear about a new request. Never throws into
 * the caller — call through deferNotify, after the change is committed.
 */
const shopUrl = (requestId: string | null) => (requestId ? `/more/marketing/${requestId}` : "/more/marketing");

export async function notifyMarketingDecision(
  restaurantId: string,
  requestId: string,
  title: string,
  decision: "approved" | "rejected" | "in_progress" | "completed",
  remarks: string | null,
): Promise<void> {
  const words = { approved: "was approved", rejected: "was not approved", in_progress: "is now in progress", completed: "is complete" }[decision];
  await notifyShop(restaurantId, {
    category: "marketing",
    title: "Marketing request update",
    body: `"${title}" ${words}.${remarks ? ` ${remarks}` : ""}`.slice(0, 300),
    url: shopUrl(requestId),
    data: { requestId, status: decision },
  });
}

export async function notifyCampaignWindow(
  restaurantId: string,
  campaignTitle: string,
  requestId: string | null,
  event: "started" | "ended",
): Promise<void> {
  await notifyShop(restaurantId, {
    category: "marketing",
    title: event === "started" ? "Your promotion is live" : "Your promotion has ended",
    body: event === "started" ? `"${campaignTitle}" is now running on Deligro.` : `"${campaignTitle}" has finished.`,
    url: shopUrl(requestId),
    data: { kind: `campaign_${event}`, requestId },
  });
}
