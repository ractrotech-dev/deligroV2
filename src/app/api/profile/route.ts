import { NextResponse } from "next/server";
import { featureOffResponse, riderProfileEditBlocked } from "@/lib/features/guards.server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "@/lib/data-access/profile";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/** PATCH /api/profile — update name or phone for the signed-in user. */
export async function PATCH(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // A phone change now consumes an OTP, so this also bounds guessing at the code.
  if (await riderProfileEditBlocked()) return featureOffResponse("driver.profile_edit");
  const limit = await rateLimit(`profile-update:${user.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: { fullName?: string; phone?: string; phoneOtp?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    await updateProfile(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "server_error";
    if (
      message === "invalid_name" ||
      message === "invalid_phone" ||
      message === "otp_required" ||
      message === "otp_invalid"
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (message === "phone_taken") {
      return NextResponse.json({ error: "phone_taken" }, { status: 409 });
    }
    // A verified rider's name changes through a change request (0086).
    if (message === "needs_approval") {
      return NextResponse.json({ error: "needs_approval", field: "fullName" }, { status: 409 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
