import "server-only";
import { NextResponse } from "next/server";
import { getProfile, type Profile } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { riderWorkBlock } from "@/lib/data-access/rider-work";

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
 *   403 account_suspended / verification_rejected — a rider ops has suspended or
 *                         rejected (0151 rider_can_work). Every route refuses
 *                         them — they cannot go online, take an offer or move
 *                         a delivery — except sign-out (`allowBlocked`). The
 *                         Rider app shows a blocking screen on this answer.
 *                         Suspension is refused while a rider carries an order,
 *                         so this never strands a delivery.
 */
export async function requireRiderApi(opts: { allowBlocked?: boolean } = {}): Promise<
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
  if (!opts.allowBlocked) {
    // A failed read throws (500), never "free to work" (AGENTS.md rule 2).
    const block = await riderWorkBlock(profile.id);
    if (block) {
      return {
        ok: false,
        response: NextResponse.json({ error: block }, { status: 403 }),
      };
    }
  }
  return { ok: true, profile };
}
