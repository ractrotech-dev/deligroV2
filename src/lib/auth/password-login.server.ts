import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, type RateLimitResult } from "@/lib/rate-limit";

/**
 * Mobile number + password sign-in, shared by the operator portals' Server
 * Action (`signInWithMobileAction`) and the native apps' route
 * (`POST /api/auth/password-login`), so both doors have one lookup and one set
 * of limits.
 *
 * The lookup — number → profile → auth user's email — runs with the service
 * role before anyone is signed in. The email is used immediately and never
 * returned to the caller.
 */

/** Per-IP and per-number caps. Password guessing is the whole threat here. */
export const PASSWORD_LOGIN_LIMITS = {
  ip: 20,
  phone: 10,
  windowMs: 15 * 60_000,
} as const;

/**
 * Both buckets must pass: one stops a single client walking a list of numbers,
 * the other a distributed attempt on one known number. Returns the refusing
 * bucket, or null when the attempt may go ahead.
 */
export async function passwordLoginRefusal(
  ip: string,
  e164: string
): Promise<RateLimitResult | null> {
  const [byIp, byPhone] = await Promise.all([
    rateLimit(`pw-login-ip:${ip}`, PASSWORD_LOGIN_LIMITS.ip, PASSWORD_LOGIN_LIMITS.windowMs),
    rateLimit(`pw-login-phone:${e164}`, PASSWORD_LOGIN_LIMITS.phone, PASSWORD_LOGIN_LIMITS.windowMs),
  ]);
  if (!byIp.ok) return byIp;
  if (!byPhone.ok) return byPhone;
  return null;
}

export type PasswordLoginEmail =
  | { ok: true; email: string }
  | { ok: false; error: "bad_credentials" | "no_email" };

/**
 * The auth email behind a mobile number. `no_email` means a real account that
 * cannot hold a password — the portal action says so (an admin must fix it);
 * the public route answers `bad_credentials` instead, because it would
 * otherwise confirm the number exists before any password is checked.
 */
export async function resolvePasswordLoginEmail(
  e164: string
): Promise<PasswordLoginEmail> {
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("phone", e164)
    .maybeSingle();

  const ownerId = (profile as { id: string } | null)?.id;
  if (!ownerId) return { ok: false, error: "bad_credentials" };

  const { data: userData, error: userErr } =
    await admin.auth.admin.getUserById(ownerId);
  const email = userData?.user?.email;
  if (userErr || !email) return { ok: false, error: "no_email" };
  return { ok: true, email };
}
