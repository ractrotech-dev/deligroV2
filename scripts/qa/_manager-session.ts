/**
 * QA — a signed-in manager session for the scripts that check routes as a
 * manager. Signs in by email and password straight against Supabase Auth (as
 * the Manager app's email sign-in does) with QA_MANAGER_EMAIL /
 * QA_MANAGER_PASSWORD from `.env.local`, and returns the `@supabase/ssr`
 * cookie the website reads. An explicit QA_MANAGER_COOKIE wins.
 *
 * Never prints the credentials or the cookie.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./_env";

/** The `sb-<ref>-auth-token` cookie (chunked like @supabase/ssr) for a session. */
export function sessionCookie(session: Record<string, unknown>): string {
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const size = 3180;
  if (value.length <= size) return `${name}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += size, n++) parts.push(`${name}.${n}=${value.slice(i, i + size)}`);
  return parts.join("; ");
}

let cached: Promise<string | null> | null = null;

/**
 * The manager cookie, or null (with the reason logged once) when no
 * credentials are configured or the sign-in is refused. Cached per run.
 */
export function managerCookie(): Promise<string | null> {
  cached ??= (async () => {
    if (process.env.QA_MANAGER_COOKIE) return process.env.QA_MANAGER_COOKIE;
    const email = process.env.QA_MANAGER_EMAIL ?? "";
    const password = process.env.QA_MANAGER_PASSWORD ?? "";
    if (!email || !password || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.log("  (no manager login: set QA_MANAGER_EMAIL and QA_MANAGER_PASSWORD in .env.local)");
      return null;
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      console.log(`  (manager sign-in refused: ${error?.message ?? "no session"})`);
      return null;
    }
    const s = data.session;
    return sessionCookie({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at,
      expires_in: s.expires_in,
      token_type: "bearer",
      user: s.user,
    });
  })();
  return cached;
}
