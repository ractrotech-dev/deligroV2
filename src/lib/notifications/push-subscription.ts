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
 * Nothing else about registration changes for customers or vendors.
 *
 * Service role: the other profiles are not the caller's to write under RLS.
 * Never throws: a failed clean-up must not fail the caller's own registration
 * (riders also never get the player-id fallback, so for them the stale copy
 * is harmless — see notify-user.ts).
 */
export async function releaseSubscriptionFromOthers(userId: string, playerId: string): Promise<boolean> {
  try {
    const { error } = await createAdminClient()
      .from("profiles")
      .update({ onesignal_id: null })
      .eq("onesignal_id", playerId)
      .neq("id", userId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * A rider signed out: their profile stops naming the phone's subscription, so
 * nothing addressed to them by player id can reach whoever signs in next.
 */
export async function clearOwnSubscription(userId: string): Promise<boolean> {
  try {
    const { error } = await createAdminClient().from("profiles").update({ onesignal_id: null }).eq("id", userId);
    return !error;
  } catch {
    return false;
  }
}
