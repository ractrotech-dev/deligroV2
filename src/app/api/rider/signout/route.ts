import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { forceRiderOffline } from "@/lib/data-access/rider-status";
import { clearOwnSubscription } from "@/lib/notifications/push-subscription";

/**
 * POST /api/rider/signout
 *
 * The app calls this just before it ends its Supabase session, so a rider who
 * signs out is not left "online" to dispatch for the length of the presence
 * window. It takes the rider offline (shift closed, ended_by "logout") and
 * deliberately does NOT end the session: the native app owns its tokens and
 * clears them itself.
 *
 * It also clears the rider's stored OneSignal subscription id (ruling P8-R7),
 * so the phone — which the next rider may sign in on — is no longer theirs.
 *
 *   200 { ok: true }
 *   503 migration_pending   (the app should sign out regardless)
 */
export async function POST() {
  // A suspended rider can still sign out.
  const auth = await requireRiderApi({ allowBlocked: true });
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-signout:${profile.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    // First, and whatever happens next: the phone stops being this rider's.
    await clearOwnSubscription(profile.id);
    await forceRiderOffline(profile.id, "logout");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/signout", method: "POST", riderId: profile.id });
  }
}
