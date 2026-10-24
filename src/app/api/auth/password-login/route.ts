import { NextResponse } from "next/server";
import { toE164 } from "@/lib/auth/phone";
import {
  passwordLoginRefusal,
  resolvePasswordLoginEmail,
} from "@/lib/auth/password-login.server";
import { customerLoginRefusal } from "@/lib/auth/account-status.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, tooManyRequests } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createPublicClient } from "@/lib/supabase/server";
import { recordSignIn } from "@/lib/obs/sign-ins";

/**
 * POST /api/auth/password-login  { mobile, password }
 * → 200 { accessToken, refreshToken, expiresAt }
 *
 * Mobile + password sign-in for the native apps — the same lookup and limits
 * as the portals' `signInWithMobileAction`, but the session comes back as
 * tokens (the app hands them to its Supabase SDK) instead of a cookie.
 *
 * Refusals: 400 `bad_request`; 401 `bad_credentials`; 429 when either the
 * per-IP or the per-number bucket is spent.
 *
 * An unknown number, a wrong password and an account with no email all answer
 * `bad_credentials`. The portal action tells a vendor their account has no
 * email; a public endpoint must not, because that would confirm the number
 * exists before any password is checked.
 *
 * Grants nothing by itself: what the account may open is decided by each
 * route's own role check (`/api/vendor/*` → vendorApiContext).
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  let body: { mobile?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const e164 = typeof body.mobile === "string" ? toE164(body.mobile) : null;
  const password = typeof body.password === "string" ? body.password : "";
  if (!e164 || !password) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const refusal = await passwordLoginRefusal(clientIp(request), e164);
  if (refusal) return tooManyRequests(refusal);

  try {
    const lookup = await resolvePasswordLoginEmail(e164);
    if (!lookup.ok) {
      recordSignIn(request, { method: "password", outcome: "failure", reason: "bad_credentials", phone: e164 });
      return NextResponse.json({ error: "bad_credentials" }, { status: 401 });
    }

    // A client that keeps no session: nothing is set on this response.
    const { data, error } = await createPublicClient().auth.signInWithPassword({
      email: lookup.email,
      password,
    });
    if (error || !data.session) {
      // Supabase Auth bans a suspended customer, so their sign-in fails here rather
      // than below. Say why - and only for a suspended customer account; every other
      // failure stays the uniform bad_credentials. (This confirms, to someone who knows a
      // suspended customer's number, that the account exists and is suspended. That sits
      // behind the same per-IP and per-number limits as every guess, and the customer's
      // own sign-in, the OTP path, tells nobody anything before the code is proven.)
      if ((error as { code?: string } | null)?.code === "user_banned"
          && (await customerLoginRefusal({ phone: e164 })) === "account_suspended") {
        recordSignIn(request, { method: "password", outcome: "failure", reason: "suspended", phone: e164 });
        return NextResponse.json({ error: "account_suspended" }, { status: 403 });
      }
      recordSignIn(request, { method: "password", outcome: "failure", reason: "bad_credentials", phone: e164 });
      return NextResponse.json({ error: "bad_credentials" }, { status: 401 });
    }

    // A suspended customer (0162): the session just made is ended at once and
    // never handed over - and so is one whose status could not be read.
    const refusal = await customerLoginRefusal({ userId: data.session.user.id });
    if (refusal) {
      await createAdminClient().auth.admin.signOut(data.session.access_token).catch(() => {});
      return refusal === "unavailable"
        ? NextResponse.json({ error: "try_again" }, { status: 503 })
        : NextResponse.json({ error: "account_suspended" }, { status: 403 });
    }

    recordSignIn(request, { method: "password", outcome: "success", actorId: data.session.user.id, phone: e164 });
    return NextResponse.json({
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    });
  } catch (err) {
    console.error("[auth/password-login]", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
