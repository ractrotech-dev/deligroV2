import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { listLiveAnnouncements } from "@/lib/data-access/announcements";

/**
 * GET /api/rider/announcements — what Deligro is telling riders right now:
 * live announcements for riders and for everyone working, newest first. The
 * app pins them at the top of the inbox.
 *
 *   200 { announcements: { id, audience, title, body, startsAt, endsAt }[] }
 *       (empty before 0087)
 *   401 · 403 not_rider · 429 · 500
 */
export async function GET() {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-announcements:${profile.id}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    return NextResponse.json(
      { announcements: await listLiveAnnouncements("rider") },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/announcements", method: "GET", riderId: profile.id, event: "announcements" });
  }
}
