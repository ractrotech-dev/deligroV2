import "server-only";
import { recordProvider } from "@/lib/obs/emit";
import { pushBody, pushReached, type PushOptions, type PushText } from "./push-body";

/**
 * OneSignal push — server-side sender.
 *
 * The legacy site pushed order updates through OneSignal (which sits on top of
 * FCM / APNs / web-push and bundles the service worker + VAPID keys), so we
 * reuse the same project. Credentials come from the environment:
 *
 *   ONESIGNAL_APP_ID          — public app id (also exposed to the client SDK)
 *   ONESIGNAL_REST_API_KEY    — SECRET. Server only. Never NEXT_PUBLIC_.
 *
 * If either is unset the sender is a silent no-op, so dev/demo and the build
 * work without credentials (mirrors the Supabase "demo mode" guard).
 */

const APP_ID = process.env.ONESIGNAL_APP_ID ?? process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID ?? "";
const REST_KEY = process.env.ONESIGNAL_REST_API_KEY ?? "";
const CHANNEL_ID = process.env.ONESIGNAL_ANDROID_CHANNEL_ID ?? "";

export const isPushConfigured = APP_ID.length > 0 && REST_KEY.length > 0;

const ENDPOINT = "https://onesignal.com/api/v1/notifications";

export type { PushOptions, PushText };

function localized(text: string | PushText): PushText {
  return typeof text === "string" ? { en: text } : text;
}

/**
 * Who to send to.
 *
 * `userIds` is the primary target: the browser SDK calls `OneSignal.login(user.id)`
 * (see onesignal-init.tsx), which makes the profile id the subscription's
 * `external_id`, so every device a person is signed in on gets the push — the
 * counter tablet and the owner's phone, not whichever registered last.
 *
 * `playerIds` is the fallback for devices that subscribed before login existed
 * and have not opened the app since. It is only tried when the external-id send
 * reached nobody: the two targets cannot be combined in one request.
 */
export interface PushTarget {
  userIds?: Array<string | null | undefined>;
  playerIds?: Array<string | null | undefined>;
}

function present(ids: Array<string | null | undefined> | undefined): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * One create-notification call. Returns true only when OneSignal accepted it
 * AND it had somebody to deliver to: a send to an external id with no
 * subscribed device comes back 200 with an empty `id`, which is the signal to
 * try the fallback target rather than a success.
 */
async function createNotification(
  targeting: Record<string, unknown>,
  heading: PushText,
  message: PushText,
  opts: PushOptions,
  targetKind: "external_id" | "player_id",
  count: number
): Promise<boolean> {
  const body = pushBody(APP_ID, targeting, heading, message, opts, CHANNEL_ID);

  // Fire-and-forget still has to be observable. Before this, a push that
  // OneSignal rejected and a push that was never attempted looked identical
  // from outside — `false`, and nothing else — so "customers stopped being told
  // their order was on its way" was not a question anyone could answer.
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Basic ${REST_KEY}`,
      },
      body: JSON.stringify(body),
      // Don't let a slow provider hang the caller.
      signal: AbortSignal.timeout(8000),
    });
    let reached = res.ok;
    if (res.ok) {
      // "Accepted" is not "reached anyone": OneSignal answers 200 with an
      // empty `id` when none of the targets resolve, and that is what has to
      // trigger the player-id fallback (see pushReached for why `errors` is not).
      const json = (await res.json().catch(() => null)) as { id?: string } | null;
      reached = pushReached(json);
    }
    // The status line, not the body: OneSignal echoes the notification
    // payload back on some errors, and that payload contains player ids.
    let detail: string | undefined;
    if (!res.ok) detail = res.statusText;
    else if (!reached) detail = "no_subscribed_recipients";
    recordProvider(
      "onesignal",
      "notifications.create",
      {
        ok: res.ok,
        durationMs: Date.now() - started,
        status: res.status,
        detail,
      },
      { attrs: { itemCount: count, target: targetKind } }
    );
    return reached;
  } catch (err) {
    // Network error / timeout / abort — swallowed, but not silent. A timeout
    // here is the 8s abort above, which is a different diagnosis to a 400.
    recordProvider(
      "onesignal",
      "notifications.create",
      {
        ok: false,
        durationMs: Date.now() - started,
        detail: err instanceof Error ? err.name : "network_error",
      },
      { attrs: { itemCount: count, target: targetKind } }
    );
    return false;
  }
}

/**
 * Send a push. Best-effort: never throws into the caller's request path — a
 * failed push must not fail an order update. Returns true if it reached at
 * least one device.
 *
 * A bare string or array is read as player ids, the pre-login call shape.
 */
export async function sendPush(
  target: PushTarget | string | Array<string | null | undefined>,
  heading: string | PushText,
  message: string | PushText,
  opts: PushOptions = {}
): Promise<boolean> {
  if (!isPushConfigured) return false;

  const t: PushTarget =
    typeof target === "string" || Array.isArray(target)
      ? { playerIds: Array.isArray(target) ? target : [target] }
      : target;
  const userIds = present(t.userIds);
  const playerIds = present(t.playerIds);
  const h = localized(heading);
  const m = localized(message);

  if (userIds.length > 0) {
    const reached = await createNotification(
      { include_aliases: { external_id: userIds }, target_channel: "push" },
      h,
      m,
      opts,
      "external_id",
      userIds.length
    );
    if (reached) return true;
  }

  if (playerIds.length > 0) {
    return createNotification(
      { include_player_ids: playerIds },
      h,
      m,
      opts,
      "player_id",
      playerIds.length
    );
  }
  return false;
}

/**
 * Which account a push subscription is logged in as: the subscription's
 * `external_id`, which `OneSignal.login(user.id)` on the device sets. Null
 * when push is not configured, the lookup fails or times out, or the
 * subscription has no external id yet — callers treat null as "not proven".
 *
 * Used to prove possession before a subscription id is taken off other
 * profiles (push-subscription.ts). The id in a register request is only what
 * the client says; OneSignal's own record of who the device is logged in as
 * is not.
 */
export async function subscriptionExternalId(subscriptionId: string): Promise<string | null> {
  if (!isPushConfigured || !/^[0-9a-f-]{8,64}$/i.test(subscriptionId)) return null;
  const url = `https://api.onesignal.com/apps/${encodeURIComponent(APP_ID)}/subscriptions/${encodeURIComponent(subscriptionId)}/user/identity`;
  // Legacy REST keys authenticate as Basic, current ones as Key.
  for (const scheme of ["Basic", "Key"]) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `${scheme} ${REST_KEY}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 401 || res.status === 403) continue;
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { identity?: { external_id?: unknown } } | null;
      const id = json?.identity?.external_id;
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}
