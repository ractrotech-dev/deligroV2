import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { sendPush, type PushOptions } from "./onesignal";

/**
 * One way to tell a person something: a row in their in-app inbox
 * (`user_notifications`, 0064) and a push. Role-generic — the Rider plan's
 * `notifyUser` is meant to be this same function (see its phase 7 plan).
 *
 * Never throws into the caller: a notification that failed must not roll back
 * whatever it was about. Before 0064 the inbox write is skipped and the push
 * still goes.
 */
export type NotificationRole = "vendor" | "rider" | "manager" | "customer" | "admin";

/** What a vendor can be told about (requirements §13). */
export type VendorNotificationCategory =
  | "orders"
  | "pending_orders"
  | "low_stock"
  | "payments"
  | "marketing"
  | "support"
  | "reviews"
  | "announcements"
  | "offers";

export interface NotifyInput {
  userId: string;
  role: NotificationRole;
  category: string;
  title: string;
  body: string;
  /** Where a tap goes in the app (e.g. `/orders/<id>`). */
  url?: string;
  data?: Record<string, unknown>;
  /** False = inbox only. */
  push?: boolean;
  /** Extra push options (ring data, channel). */
  pushOptions?: PushOptions;
}

let inboxMissing = false;

/** The inbox row alone; true when written. */
export async function recordNotification(n: Omit<NotifyInput, "push" | "pushOptions">): Promise<boolean> {
  if (inboxMissing) return false;
  try {
    const { error } = await createAdminClient()
      .from("user_notifications")
      .insert({
        user_id: n.userId,
        role: n.role,
        category: n.category,
        title: n.title.slice(0, 200),
        body: n.body.slice(0, 1000),
        data: { ...(n.data ?? {}), ...(n.url ? { url: n.url } : {}) },
      });
    if (error) {
      if (isMissingTable(error)) inboxMissing = true;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function notifyUser(n: NotifyInput): Promise<void> {
  await recordNotification(n);
  if (n.push === false) return;
  try {
    await sendPush({ userIds: [n.userId] }, { en: n.title }, { en: n.body }, {
      url: n.url,
      ...n.pushOptions,
      data: { category: n.category, ...(n.url ? { url: n.url } : {}), ...(n.data ?? {}), ...(n.pushOptions?.data ?? {}) },
    });
  } catch {
    // swallow — fire-and-forget
  }
}

/** Every owner of a shop: today one, but a shop's owner is the unit pushes go to. */
export async function shopOwnerId(restaurantId: string): Promise<string | null> {
  try {
    const { data } = await createAdminClient().from("restaurants").select("owner_id").eq("id", restaurantId).maybeSingle();
    return (data?.owner_id as string | null) ?? null;
  } catch {
    return null;
  }
}

/** Tell a shop's owner something (inbox + push). */
export async function notifyShop(
  restaurantId: string,
  n: Omit<NotifyInput, "userId" | "role"> & { category: VendorNotificationCategory }
): Promise<void> {
  const owner = await shopOwnerId(restaurantId);
  if (owner) await notifyUser({ ...n, userId: owner, role: "vendor" });
}
