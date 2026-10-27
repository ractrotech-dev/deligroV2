import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Which account a phone's OneSignal subscription belongs to (ruling P8-R7).
 *
 * A subscription id belongs to one app install on one phone. When a second
 * person signs in on that phone (riders share fleet phones), the id moves to
 * them: it must not stay on the previous person's profile too, or their
 * player-id fallback would push their notices to the phone the next person now
 * carries. So registering an id clears it from every OTHER profile that holds
 * it — for every role, because a subscription id names a device, not a role.
 *
 * Only when possession is PROVEN (2026-10-28 audit). The id in a register
 * request is whatever the client says, and a shop owner can read the
 * onesignal_id of every customer who ordered from them (0008), so clearing it
 * from any role on the caller's word let anyone detach another person's
 * subscription. `proven` means OneSignal reports the subscription logged in as
 * the caller (`subscriptionExternalId`). Unproven, only rider copies are
 * cleared: a rider's copy never drives a push (riders get no player-id
 * fallback, notify-user.ts), so releasing it on the caller's word is harmless.
 * Every role's own sign-out also clears its copy (`clearOwnSubscription`).
 *
 * Service role: the other profiles are not the caller's to write under RLS.
 * Never throws: a failed clean-up must not fail the caller's own registration.
 */
export async function releaseSubscriptionFromOthers(
  userId: string,
  playerId: string,
  opts: { proven?: boolean } = {}
): Promise<boolean> {
  try {
    let q = createAdminClient()
      .from("profiles")
      .update({ onesignal_id: null })
      .eq("onesignal_id", playerId)
      .neq("id", userId);
    if (!opts.proven) q = q.eq("role", "driver");
    const { error } = await q;
    return !error;
  } catch {
    return false;
  }
}

/**
 * Someone signed out: their profile stops naming the phone's subscription, so
 * nothing addressed to them by player id can reach whoever signs in next.
 * Every role since the 2026-10-28 audit (it was riders only): /auth/signout,
 * /api/rider/signout and DELETE /api/notifications/register (the apps).
 */
export async function clearOwnSubscription(userId: string): Promise<boolean> {
  try {
    const { error } = await createAdminClient().from("profiles").update({ onesignal_id: null }).eq("id", userId);
    return !error;
  } catch {
    return false;
  }
}
