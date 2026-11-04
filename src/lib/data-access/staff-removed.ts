import "server-only";
import { cache } from "react";
import { captureError } from "@/lib/obs/emit";
import { isMissingColumn } from "@/lib/data-access/schema-probe";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Who has been removed from the team (0202), so the lists can leave them out.
 *
 * This only tidies lists, and is not what keeps anyone out: a removed account is
 * suspended and banned, and the gates hold whatever this answers. So a failed read
 * costs a tidy list rather than the screen. A database without 0202 has nobody
 * removed. Service role: the column is not granted to anyone else.
 */
export const removedStaffIds = cache(async (role?: "manager" | "driver"): Promise<Set<string>> => {
  let query = createAdminClient().from("profiles").select("id").not("removed_at", "is", null);
  if (role) query = query.eq("role", role);
  const { data, error } = await query;
  if (error) {
    if (!isMissingColumn(error)) captureError(error, { source: "staff-access", attrs: { event: "removed_staff_read_failed" } });
    return new Set();
  }
  return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
});
