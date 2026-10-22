import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { isLockedCategory, pushAllowed } from "@/lib/rider/notification-prefs";
import { isPushConfigured, sendPush, type PushOptions } from "./onesignal";

/**
 * One way to tell a person something: a row in their in-app inbox
 * (`user_notifications`, 0064 / 0087) and a push. Role-generic — the Partner
 * app's `notifyUser` (feat/vendor-app) and the Rider plan's are this same
 * function; this copy is a superset of the Partner one (same exports and call
 * shape), adding the rider's per-category preferences, the stored OneSignal
 * player id as a fallback target (never for riders — P8-R7), a bulk form for
 * announcements, and a result.
 *
 * Order of work, and why:
 *
 *   1. The inbox row is written FIRST and ALWAYS — even when the push is
 *      muted, unconfigured or fails. The inbox is the record (Review Focus 2:
 *      a rider who switches payouts off still finds the payout in the inbox).
 *   2. A rider's push is skipped when they switched the category off
 *      (`rider_profiles.notification_prefs`, Phase 6; `pushAllowed`). Offers,
 *      cancellations and safety cannot be switched off. Before Phase 6's column
 *      exists every category is on.
 *   3. The push carries `category`, `url` (the app route a tap opens) and the
 *      inbox row's id in its data.
 *
 * Never throws into the caller: a notification that failed must not roll back
 * whatever it was about. Before 0087 (or 0064) the inbox write is skipped and
 * the push still goes.
 *
 * Ring STOP signals do not come here: they are silent data pushes with nothing
 * to read, so they stay raw (`order-events.ts`) and leave no inbox row.
 */
export type NotificationRole = "vendor" | "rider" | "manager" | "customer" | "admin";

/** What a vendor can be told about (Partner app requirements §13). */
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
  /** Where a tap goes in the app (e.g. `/help/tickets/<id>`). */
  url?: string;
  data?: Record<string, unknown>;
  /** False = inbox only. */
  push?: boolean;
  /** Extra push options (ring data, priority, the web `url`). */
  pushOptions?: PushOptions;
}

export interface NotifyResult {
  /** The inbox row was written. */
  inbox: boolean;
  /** OneSignal reached at least one device. */
  pushed: boolean;
  /** The rider switched this category off: no push was attempted. */
  muted: boolean;
}

/**
 * The push sender. A seam for `scripts/qa/support-notifications.ts`, which
 * swaps in a recorder so nothing is ever sent; production never touches it.
 */
export const pushTransport: {
  configured: () => boolean;
  send: typeof sendPush;
} = {
  configured: () => isPushConfigured,
  send: sendPush,
};

const PREFS_COLUMN = "rider_profiles.notification_prefs";
const INSERT_CHUNK = 500;
const PUSH_CHUNK = 1000;

/**
 * When the inbox table was last found missing. Not a permanent latch: after
 * INBOX_REPROBE_MS the next write tries again, so applying 0087 takes effect
 * without restarting anything.
 */
let inboxMissingAt = 0;
const INBOX_REPROBE_MS = 5 * 60_000;
const inboxKnownMissing = () => inboxMissingAt > 0 && Date.now() - inboxMissingAt < INBOX_REPROBE_MS;

/** Tests only: forget the "inbox table is missing" latch between cases. */
export function __resetNotifyForTests(): void {
  inboxMissingAt = 0;
}

/** Tests only: pretend the "missing" answer is `ms` older than it is. */
export function __ageInboxLatchForTests(ms: number): void {
  if (inboxMissingAt > 0) inboxMissingAt -= ms;
}

function inboxRow(n: Omit<NotifyInput, "push" | "pushOptions">) {
  return {
    user_id: n.userId,
    role: n.role,
    category: n.category,
    title: n.title.slice(0, 200),
    body: n.body.slice(0, 1000),
    data: { ...(n.data ?? {}), ...(n.url ? { url: n.url } : {}) },
  };
}

/** Inserts inbox rows; the new ids in order, or null when nothing was written. */
async function insertInbox(rows: ReturnType<typeof inboxRow>[]): Promise<string[] | null> {
  if (inboxKnownMissing() || rows.length === 0) return null;
  try {
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const { data, error } = await createAdminClient()
        .from("user_notifications")
        .insert(rows.slice(i, i + INSERT_CHUNK))
        .select("id")
        .overrideTypes<{ id: string }[]>();
      if (error) {
        if (isMissingTable(error)) inboxMissingAt = Date.now();
        return ids.length ? ids : null;
      }
      ids.push(...(data ?? []).map((r) => r.id));
    }
    inboxMissingAt = 0;
    return ids;
  } catch {
    return null;
  }
}

/** The inbox row alone; true when written. */
export async function recordNotification(n: Omit<NotifyInput, "push" | "pushOptions">): Promise<boolean> {
  return (await insertInbox([inboxRow(n)])) !== null;
}

/**
 * Each rider's stored preferences. A database without Phase 6's column, a
 * missing row or an unreadable table all read as "no preferences" — every
 * category on — because a lost alert is worse than an unwanted one.
 */
export async function riderPrefs(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0 || columnKnownMissing(PREFS_COLUMN)) return out;
  try {
    const { data, error } = await createAdminClient()
      .from("rider_profiles")
      .select("driver_id, notification_prefs")
      .in("driver_id", ids)
      .overrideTypes<{ driver_id: string; notification_prefs: Record<string, unknown> | null }[]>();
    if (error) {
      if (isMissingColumn(error)) rememberColumn(PREFS_COLUMN, false);
      return out;
    }
    for (const r of data ?? []) if (r.notification_prefs) out.set(r.driver_id, r.notification_prefs);
  } catch {
    // every category on
  }
  return out;
}

/**
 * `profiles.onesignal_id` — the pre-login subscription fallback — for each user
 * that has one.
 *
 * Never for riders (ruling P8-R7): riders share fleet phones, and a stored
 * subscription id names the PHONE, which may now be in the next rider's
 * pocket. A rider is reached by their external id (OneSignal.login) only;
 * callers pass non-rider ids here.
 */
async function playerIdsOf(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  try {
    const { data } = await createAdminClient()
      .from("profiles")
      .select("id, onesignal_id")
      .in("id", userIds)
      .overrideTypes<{ id: string; onesignal_id: string | null }[]>();
    return (data ?? []).map((r) => r.onesignal_id).filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

function pushData(n: Omit<NotifyInput, "userId" | "role">, extra: Record<string, unknown> = {}) {
  return {
    category: n.category,
    ...(n.url ? { url: n.url } : {}),
    ...(n.data ?? {}),
    ...extra,
    ...(n.pushOptions?.data ?? {}),
  };
}

export async function notifyUser(n: NotifyInput): Promise<NotifyResult> {
  const ids = await insertInbox([inboxRow(n)]);
  const inbox = ids !== null && ids.length > 0;
  if (n.push === false) return { inbox, pushed: false, muted: false };

  // Offers, cancellations and safety always push: no preference to read.
  if (n.role === "rider" && !isLockedCategory(n.category)) {
    const prefs = await riderPrefs([n.userId]);
    if (!pushAllowed(prefs.get(n.userId), n.category)) return { inbox, pushed: false, muted: true };
  }
  if (!pushTransport.configured()) return { inbox, pushed: false, muted: false };

  try {
    const players = n.role === "rider" ? [] : await playerIdsOf([n.userId]);
    const pushed = await pushTransport.send(
      { userIds: [n.userId], playerIds: players },
      { en: n.title },
      { en: n.body },
      {
        url: n.url,
        ...n.pushOptions,
        data: pushData(n, inbox && ids ? { notificationId: ids[0] } : {}),
      }
    );
    return { inbox, pushed, muted: false };
  } catch {
    return { inbox, pushed: false, muted: false };
  }
}

/**
 * The same message to many people (an announcement, a high-demand call): one
 * inbox insert per 500 and one push per 1000 recipients, riders who muted the
 * category left out of the push. Counts are people, not calls.
 */
export async function notifyUsers(
  people: { userId: string; role: NotificationRole }[],
  n: Omit<NotifyInput, "userId" | "role">
): Promise<{ inbox: number; pushed: number; muted: number }> {
  const unique = [...new Map(people.map((p) => [p.userId, p])).values()];
  if (unique.length === 0) return { inbox: 0, pushed: 0, muted: 0 };
  const ids = await insertInbox(unique.map((p) => inboxRow({ ...n, userId: p.userId, role: p.role })));
  const inbox = ids?.length ?? 0;
  if (n.push === false) return { inbox, pushed: 0, muted: 0 };

  const riders = isLockedCategory(n.category) ? [] : unique.filter((p) => p.role === "rider").map((p) => p.userId);
  const prefs = await riderPrefs(riders);
  const allowed = unique.filter((p) => p.role !== "rider" || pushAllowed(prefs.get(p.userId), n.category));
  const muted = unique.length - allowed.length;
  if (!pushTransport.configured() || allowed.length === 0) return { inbox, pushed: 0, muted };

  let pushed = 0;
  for (let i = 0; i < allowed.length; i += PUSH_CHUNK) {
    const people = allowed.slice(i, i + PUSH_CHUNK);
    const chunk = people.map((p) => p.userId);
    try {
      // The player ids are only tried when the external-id send reached
      // nobody (sendPush), the same fallback as a single push — and never
      // a rider's (P8-R7).
      const players = await playerIdsOf(people.filter((p) => p.role !== "rider").map((p) => p.userId));
      const ok = await pushTransport.send({ userIds: chunk, playerIds: players }, { en: n.title }, { en: n.body }, {
        url: n.url,
        ...n.pushOptions,
        data: pushData(n),
      });
      if (ok) pushed += chunk.length;
    } catch {
      // the inbox rows stand
    }
  }
  return { inbox, pushed, muted };
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
