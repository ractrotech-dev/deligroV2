import "server-only";
import { NextResponse } from "next/server";
import { getProfile, type Profile } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";

/**
 * The door for `/api/rider/*` — the JSON API the native rider app calls.
 *
 * Every route starts here, before it reads a body, takes a rate-limit slot or
 * touches the service-role client (AGENTS.md rules 3 and 5). The answer is the
 * session's own profile, and the rider id every route uses is `profile.id`:
 * there is no id in any request body or URL for a caller to substitute.
 *
 *   503 not_configured  — no Supabase keys; refuse rather than guess (rule 2)
 *   401 unauthenticated — no session
 *   403 not_rider       — signed in, but not a delivery partner. Admins are
 *                         refused too: the rider app acts as the rider, and an
 *                         admin has no availability of their own to change.
 */
export async function requireRiderApi(): Promise<
  { ok: true; profile: Profile } | { ok: false; response: NextResponse }
> {
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      response: NextResponse.json({ error: "not_configured" }, { status: 503 }),
    };
  }
  const profile = await getProfile();
  if (!profile) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  if (profile.role !== "driver") {
    return {
      ok: false,
      response: NextResponse.json({ error: "not_rider" }, { status: 403 }),
    };
  }
  return { ok: true, profile };
}

/**
 * The answer for a failure inside a rider route. A database without migration
 * 0081 is a known, fail-closed state (503 migration_pending); anything else is
 * an opaque 500 — the error itself stays server-side.
 */
export function riderRouteError(error: unknown): NextResponse {
  if (isRiderSchemaPending(error)) {
    return NextResponse.json({ error: "migration_pending" }, { status: 503 });
  }
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}
