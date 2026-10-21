import { NextResponse } from "next/server";
import { requireRiderApi, riderRouteError } from "@/lib/auth/rider-api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { forceRiderOffline } from "@/lib/data-access/rider-status";

/**
 * POST /api/rider/signout
 *
 * The app calls this just before it ends its Supabase session, so a rider who
 * signs out is not left "online" to dispatch for the length of the presence
 * window. It takes the rider offline (shift closed, ended_by "logout") and
 * deliberately does NOT end the session: the native app owns its tokens and
 * clears them itself.
 *
 *   200 { ok: true }
 *   503 migration_pending   (the app should sign out regardless)
 */
export async function POST() {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-signout:${profile.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    await forceRiderOffline(profile.id, "logout");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return riderRouteError(e);
  }
}
