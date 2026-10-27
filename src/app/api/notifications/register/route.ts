import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { releaseSubscriptionFromOthers } from "@/lib/notifications/push-subscription";
import { subscriptionExternalId } from "@/lib/notifications/onesignal";

/**
 * Save the signed-in user's OneSignal player id to their profile.
 * The browser SDK subscribes, then POSTs { playerId } here. Writes go through
 * the RLS server client, so a user can only ever update their own row.
 *
 * A subscription id names one phone's install. Once it is saved here it is
 * cleared from every OTHER profile that still holds it (ruling P8-R7: phones
 * are shared) — every role when OneSignal confirms the device is logged in as
 * the caller, rider profiles only otherwise. See releaseSubscriptionFromOthers.
 *
 * DELETE clears the caller's own id: the apps call it just before signing out,
 * so the next person on the phone does not get this account's notices.
 */
export async function POST(req: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  let playerId: unknown;
  try {
    ({ playerId } = await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  if (typeof playerId !== "string" || playerId.length < 8 || playerId.length > 100) {
    return NextResponse.json({ ok: false, error: "bad_player_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimit(`push-register:${user.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { error } = await supabase
    .from("profiles")
    .update({ onesignal_id: playerId })
    .eq("id", user.id);
  if (error) {
    return NextResponse.json({ ok: false, error: "save_failed" }, { status: 500 });
  }
  const proven = (await subscriptionExternalId(playerId)) === user.id;
  await releaseSubscriptionFromOthers(user.id, playerId, { proven });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimit(`push-register:${user.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { error } = await supabase
    .from("profiles")
    .update({ onesignal_id: null })
    .eq("id", user.id);
  if (error) {
    return NextResponse.json({ ok: false, error: "save_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
