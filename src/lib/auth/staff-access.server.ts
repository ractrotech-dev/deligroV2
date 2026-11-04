import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn } from "@/lib/data-access/schema-probe";

/**
 * Has an admin stopped this manager? The second lock behind the Auth ban and ended
 * sessions (data-access/staff-access.ts): it holds if either of those failed, and it
 * closes the gap until an access token issued earlier expires.
 *
 * A database without 0151 has no such column and so nobody stopped. Any other failed
 * read says yes: access must not widen because the check could not be made (AGENTS.md
 * rule 2). Riders have their own lock, `riderWorkBlock`.
 */
export const staffAccountStopped = cache(async (userId: string): Promise<boolean> => {
  const { data, error } = await createAdminClient().from("profiles").select("account_status").eq("id", userId).maybeSingle();
  if (error) return !isMissingColumn(error);
  const status = (data as { account_status?: string | null } | null)?.account_status;
  return Boolean(status) && status !== "active";
});
