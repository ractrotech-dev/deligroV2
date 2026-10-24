import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "@/lib/supabase/config";
import { watchedFetch } from "@/lib/obs/db-watch";

/**
 * Service-role client — bypasses RLS. Use ONLY in trusted server contexts
 * (seed scripts, webhooks, admin batch jobs). Never import from client code.
 */
export function createAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for admin operations");
  }
  return createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Records database refusals the caller only gets back as `{ error }`. The
    // telemetry writes themselves (obs_*) are never watched.
    global: { fetch: watchedFetch },
  });
}
