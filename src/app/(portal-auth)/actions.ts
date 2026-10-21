"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { toE164 } from "@/lib/auth/phone";
import {
  passwordLoginRefusal,
  resolvePasswordLoginEmail,
} from "@/lib/auth/password-login.server";

/**
 * Mobile-number + password sign-in for the operator portals.
 *
 * Vendors are onboarded by hand: an admin creates the shop, hands the owner
 * their mobile number and a password, and that is the whole of what they are
 * told. They do not reliably know the email address the account was created
 * with — it is often one the admin typed for them — so the email/password form
 * is a door they cannot open, and OTP depends on the SMS gateway being up and
 * the handset being in the room.
 *
 * The lookup itself lives in `password-login.server.ts`, shared with the native
 * apps' `POST /api/auth/password-login`. This is a Server Action rather than a
 * client call because the lookup it performs — number → profile → auth user's
 * email — must never be exposed as an endpoint that answers before the
 * password is checked (the native route keeps that rule). The email
 * is resolved with the service role, used immediately, and never returned; a
 * wrong password and an unknown number produce exactly the same reply.
 *
 * It grants nothing on its own: this only establishes a session. Whether that
 * account may open the portal it was used at is still decided server-side by
 * the portal layout's `requireRole()` / `requireVendorAccess()`.
 */

export interface MobileLoginResult {
  ok: boolean;
  error?: string;
}

/** Deliberately identical for "no such number" and "wrong password". */
const BAD_CREDENTIALS = "Incorrect mobile number or password.";

/** The caller's IP, from the same headers `clientIp()` reads on route handlers. */
async function callerIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

export async function signInWithMobileAction(
  mobile: string,
  password: string
): Promise<MobileLoginResult> {
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      error:
        "Auth isn't configured yet. Add your Supabase keys to .env.local, then run the migrations.",
    };
  }

  const e164 = toE164(mobile ?? "");
  if (!e164 || !password) return { ok: false, error: BAD_CREDENTIALS };

  // Per-IP and per-number buckets (PASSWORD_LOGIN_LIMITS); both must pass.
  const ip = await callerIp();
  if (await passwordLoginRefusal(ip, e164)) {
    return {
      ok: false,
      error: "Too many sign-in attempts. Wait a few minutes and try again.",
    };
  }

  const lookup = await resolvePasswordLoginEmail(e164);
  if (!lookup.ok && lookup.error === "bad_credentials") {
    return { ok: false, error: BAD_CREDENTIALS };
  }
  if (!lookup.ok) {
    // A real account with no email address cannot hold a password. Say so
    // plainly — this is a setup problem an admin has to fix, and pretending the
    // credentials were wrong would send the vendor round the same loop for ever.
    return {
      ok: false,
      error:
        "This account has no email address, so it can't use a password. Sign in with OTP, or ask an admin to add one.",
    };
  }

  // The cookie-bound client, so a success lands as a session on this response.
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: lookup.email,
    password,
  });
  if (error) return { ok: false, error: BAD_CREDENTIALS };

  return { ok: true };
}
