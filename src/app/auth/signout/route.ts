import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { CUSTOMER_LOGIN, safeNextPath } from "@/lib/auth/portals";
import { getProfile } from "@/lib/auth";
import { forceRiderOffline } from "@/lib/data-access/rider-status";

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
 * there, including a database without migration 0081, must never keep anyone
 * signed in.
 */
export async function POST(request: Request) {
  if (isSupabaseConfigured) {
    const supabase = await createClient();
    try {
      // Read before signOut: afterwards there is no session to say who this was.
      const profile = await getProfile();
      if (profile?.role === "driver") await forceRiderOffline(profile.id, "logout");
    } catch {
      // Sign-out wins over bookkeeping. The presence window (five minutes
      // without a fix) takes the rider out of dispatch regardless.
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
