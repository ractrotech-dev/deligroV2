import { NextResponse } from "next/server";
import { customerProfileEditBlocked, featureOffResponse, riderProfileEditBlocked } from "@/lib/features/guards.server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { removeAvatar, uploadAvatar } from "@/lib/data-access/profile";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * Each accepted upload is up to 5 MB into a public bucket, so an unbounded loop
 * here is storage and egress spend. The data layer owns authz; this only caps
 * the rate. Anonymous callers fall through — uploadAvatar throws `unauthorized`.
 */
async function throttle(): Promise<Response | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const limit = await rateLimit(`avatar:${user.id}`, 12, 60_000);
  return limit.ok ? null : tooManyRequests(limit);
}

/**
 * Profile photo for the signed-in user.
 *   POST   multipart/form-data { file } → upload or replace
 *   DELETE                              → remove
 *
 * The storage path is derived from the session's user id inside the data-access
 * layer, never from the request — the client cannot aim the write at another
 * user's folder, and the bucket's RLS policies enforce the same thing again.
 */

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : "server_error";
  if (message === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (message === "invalid_type" || message === "too_large") {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const limited = await throttle();
  if (limited) return limited;
  if (await riderProfileEditBlocked()) return featureOffResponse("driver.profile_edit");
  if (await customerProfileEditBlocked()) return featureOffResponse("customer.profile_edit");

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const avatarUrl = await uploadAvatar(file);
    return NextResponse.json({ ok: true, avatarUrl });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE() {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  if (await riderProfileEditBlocked()) return featureOffResponse("driver.profile_edit");
  if (await customerProfileEditBlocked()) return featureOffResponse("customer.profile_edit");

  try {
    await removeAvatar();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
