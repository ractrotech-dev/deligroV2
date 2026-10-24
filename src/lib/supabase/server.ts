import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";
import { watchedFetch } from "@/lib/obs/db-watch";

/**
 * Server-side Supabase client for Server Components, Route Handlers, and
 * Server Actions. Reads/writes the auth cookie so the session persists.
 * Next 16: cookies() is async — awaited once here.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // Records database refusals the caller only gets back as `{ error }`.
    global: { fetch: watchedFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component (read-only cookies) — safe to ignore;
          // the middleware refreshes the session on the next request.
        }
      },
    },
  });
}

/**
 * An anon client that touches no cookies — for reads that are genuinely public
 * and must not depend on who is asking.
 *
 * Two reasons this exists rather than reusing `createClient()` above.
 *
 * 1. **It can prerender.** `cookies()` opts a route out of static generation
 *    entirely, so `sitemap.xml` could not be built ahead of time and threw
 *    `DynamicServerError` during `next build` — the catalog read failed and the
 *    sitemap silently shipped with no restaurants in it.
 * 2. **It is the correct authority.** A sitemap should list what an anonymous
 *    crawler can see, not what the requesting session can see. Binding it to a
 *    session would mean the file's contents depended on who fetched it, which
 *    for a sitemap is meaningless at best.
 *
 * Still the anon key, so RLS applies exactly as it does for a logged-out
 * visitor. This is NOT `createAdminClient()` and grants nothing extra —
 * a table anon cannot read stays unreadable here.
 */
export function createPublicClient() {
  return createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: watchedFetch },
  });
}
