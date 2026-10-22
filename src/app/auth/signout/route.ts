import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { CUSTOMER_LOGIN, safeNextPath } from "@/lib/auth/portals";
import { getProfile } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { forceRiderOffline, isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { captureError } from "@/lib/obs/emit";

/** How long sign-out waits on the rider bookkeeping before it signs out anyway. */
const RIDER_OFFLINE_BUDGET_MS = 3_000;

/**
 * POST /auth/signout — clears the session and returns to a sign-in page.
 *
 * `?next=` picks which door: the portals pass their own (/admin/login, …) so an
 * operator who signs out isn't dropped on the customer entry screen. Only
 * relative in-app paths are honored, so it can't be turned into a redirector.
 *
 * A rider who signs out is taken offline first (shift closed, ended_by
 * "logout"), so they do not stay available to dispatch for the length of the
 * presence window with nobody holding the phone. That is best-effort: a failure
 * there, including a database without migration 0081 or a slow one (the
 * bookkeeping gets about three seconds), must never keep anyone signed in.
 */
export async function POST(request: Request) {
  if (isSupabaseConfigured) {
    const supabase = await createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Read before signOut: afterwards there is no session to say who this was.
      const bookkeeping = (async () => {
        const profile = await getProfile();
        if (profile?.role !== "driver") return;
        // The write is limited per rider (the bucket /api/rider/signout uses); past
        // it the sign-out still happens and the presence window does the rest.
        const limit = await rateLimit(`rider-signout:${profile.id}`, 10, 60_000);
        if (limit.ok) await forceRiderOffline(profile.id, "logout");
      })();
      // Whichever finishes first: a hung database must not hold the sign-out.
      // The losing promise is left to settle (and its rejection is handled).
      bookkeeping.catch(() => {});
      await Promise.race([
        bookkeeping,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RIDER_OFFLINE_BUDGET_MS);
        }),
      ]);
    } catch (e) {
      // Sign-out wins over bookkeeping. The presence window (five minutes
      // without a fix) takes the rider out of dispatch regardless.
      if (!isRiderSchemaPending(e)) {
        captureError(e, { source: "/auth/signout", httpMethod: "POST", attrs: { event: "rider_offline_on_signout" } });
      }
    } finally {
      clearTimeout(timer);
    }
    await supabase.auth.signOut();
  }

  const next = safeNextPath(
    new URL(request.url).searchParams.get("next"),
    CUSTOMER_LOGIN
  );

  // Mark the landing page so the client knows a session actually ENDED here.
  // Without it the only signal is "we are on a login page", and /login is the
  // customer app's entry screen — every anonymous visitor starts there, so
  // treating that as a sign-out wiped the service worker's caches on ordinary
  // first visits. `safeNextPath` has already rejected anything that is not a
  // relative in-app path, so this only ever appends to one of our own routes.
  const target = new URL(next, request.url);
  target.searchParams.set("signedout", "1");
  return NextResponse.redirect(target, { status: 303 });
}
