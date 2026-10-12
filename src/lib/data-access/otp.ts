import "server-only";
import { randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveAccountByPhone } from "@/lib/auth/customer-account";
import { checkOtpLimits, otpLookbackStart } from "@/lib/auth/otp-limits";
import { claimAttempt, type AttemptStore } from "@/lib/auth/otp-attempts";

/**
 * Server-side OTP lifecycle. All queries use the service-role client (the
 * otp_codes table is RLS-locked with no policies). The verify step mints a real
 * Supabase session by generating an admin magic-link token the client then
 * exchanges, so downstream RLS on auth.uid() keeps working unchanged.
 */

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

/**
 * The pepper is the only secret in the code hash: with it, a leaked
 * `otp_codes.code_hash` is useless; without it, six digits are brute-forced in
 * microseconds. So there is deliberately no default — a fallback value that
 * ships in the repository is not a secret, and silently running on one is worse
 * than refusing to run. Set OTP_PEPPER in every environment.
 */
function pepper(): string {
  const value = process.env.OTP_PEPPER;
  if (!value) {
    throw new Error(
      "OTP_PEPPER is not set. Generate one (`openssl rand -hex 32`) and add it " +
        "to the server environment — OTP hashes are worthless without it."
    );
  }
  return value;
}

/**
 * scrypt, not a bare SHA-256. The plaintext space is a million six-digit
 * strings, so a fast hash means that anyone who obtains both the `otp_codes`
 * table and the pepper recovers every live code in microseconds — and those two
 * live in the same infrastructure, so that is one breach, not two. scrypt puts
 * a real per-guess cost in the way. The phone doubles as the salt, so two
 * numbers holding the same code never share a digest.
 */
function hashCode(phone: string, code: string): Buffer {
  return scryptSync(`${code}:${phone}:${pepper()}`, `deligro:${phone}`, 32);
}

/**
 * Compare a stored hex digest against a freshly computed one without leaking
 * position-of-first-difference through timing. Lengths are compared first
 * because timingSafeEqual throws on a mismatch.
 */
function hashMatches(storedHex: string, computed: Buffer): boolean {
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHex, "hex");
  } catch {
    return false;
  }
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(stored, computed);
}

export interface RequestResult {
  ok: boolean;
  code?: string; // only returned in dev mode (no SMS provider)
  error?: string;
  retryAfter?: number; // seconds
  remainingToday?: number; // sends left today after this one
}

/** The Supabase side of `claimAttempt`: a compare-and-set on `otp_codes.attempts`. */
function attemptStore(supabase: ReturnType<typeof createAdminClient>): AttemptStore {
  return {
    async bump(id, expected) {
      const { data } = await supabase
        .from("otp_codes")
        .update({ attempts: expected + 1 })
        .eq("id", id)
        .eq("attempts", expected)
        .select("id");
      return (data?.length ?? 0) > 0;
    },
    async read(id) {
      const { data } = await supabase
        .from("otp_codes")
        .select("attempts")
        .eq("id", id)
        .maybeSingle();
      return data ? (data.attempts as number) : null;
    },
  };
}

/** Create + persist a fresh 6-digit code for this phone (with rate limits). */
export async function createOtp(phone: string): Promise<RequestResult> {
  const supabase = createAdminClient();
  const now = Date.now();

  // Rate limit: cooldown, hourly cap and daily cap — see lib/auth/otp-limits.
  const { data: recent, error: readError } = await supabase
    .from("otp_codes")
    .select("created_at")
    .eq("phone", phone)
    .gte("created_at", new Date(otpLookbackStart(now)).toISOString());
  // Fail closed: if we can't count the sends, we can't enforce the caps.
  if (readError) return { ok: false, error: "db_error" };

  const verdict = checkOtpLimits(
    (recent ?? []).map((r) => new Date(r.created_at).getTime()),
    now
  );
  if (!verdict.ok) {
    return { ok: false, error: verdict.error, retryAfter: verdict.retryAfter };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { error } = await supabase.from("otp_codes").insert({
    phone,
    code_hash: hashCode(phone, code).toString("hex"),
    expires_at: new Date(now + CODE_TTL_MS).toISOString(),
  });
  if (error) return { ok: false, error: "db_error" };

  return { ok: true, code, remainingToday: verdict.remainingToday };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  tokenHash?: string; // magic-link token the client exchanges for a session
  email?: string;
  isNewUser?: boolean;
}

/** Check the code, resolve/create the auth user, and mint a session token. */
export async function verifyOtp(phone: string, code: string): Promise<VerifyResult> {
  const supabase = createAdminClient();

  const { data: row } = await supabase
    .from("otp_codes")
    .select("id, code_hash, attempts, consumed, expires_at")
    .eq("phone", phone)
    .eq("consumed", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { ok: false, error: "no_code" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: "expired" };
  // Spend the attempt BEFORE comparing, so parallel guesses each pay for one.
  if (!(await claimAttempt(attemptStore(supabase), row.id, row.attempts, MAX_ATTEMPTS))) {
    return { ok: false, error: "locked" };
  }

  if (!hashMatches(row.code_hash, hashCode(phone, code))) {
    return { ok: false, error: "invalid" };
  }

  await supabase.from("otp_codes").update({ consumed: true }).eq("id", row.id);

  // Resolve the user: existing profile by phone (any role) wins, so operators
  // can OTP into their real account; otherwise create a phone-only customer.
  // Shared with the phone-order desk so both produce the same one account per
  // number — see lib/auth/customer-account.ts.
  const account = await resolveAccountByPhone(phone);
  if (!account) return { ok: false, error: "user_error" };
  const { email, isNewUser } = account;

  // Mint a magic-link token the browser exchanges to establish the session.
  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !link?.properties?.hashed_token) {
    return { ok: false, error: "session_error" };
  }

  return { ok: true, tokenHash: link.properties.hashed_token, email, isNewUser };
}

export interface CheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a code for a phone and consume it, WITHOUT resolving a user or
 * minting a session. Used to prove phone ownership in-place — e.g. an admin
 * confirming a vendor's mobile during onboarding — where establishing a session
 * for that phone would wrongly sign the admin out of their own account.
 */
export async function checkOtp(phone: string, code: string): Promise<CheckResult> {
  const supabase = createAdminClient();

  const { data: row } = await supabase
    .from("otp_codes")
    .select("id, code_hash, attempts, consumed, expires_at")
    .eq("phone", phone)
    .eq("consumed", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { ok: false, error: "no_code" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: "expired" };
  // Spend the attempt BEFORE comparing, so parallel guesses each pay for one.
  if (!(await claimAttempt(attemptStore(supabase), row.id, row.attempts, MAX_ATTEMPTS))) {
    return { ok: false, error: "locked" };
  }

  if (!hashMatches(row.code_hash, hashCode(phone, code))) {
    return { ok: false, error: "invalid" };
  }

  await supabase.from("otp_codes").update({ consumed: true }).eq("id", row.id);
  return { ok: true };
}

