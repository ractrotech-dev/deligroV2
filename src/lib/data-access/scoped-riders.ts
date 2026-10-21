import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";

/**
 * Which riders a manager may act on: those assigned (staff_zones) to one of
 * the manager's zones; every rider for an admin.
 *
 * Service role, because a manager's cookie client sees only their own
 * staff_zones rows. **Caller authorises first** (AGENTS.md rule 5) — every
 * caller sits behind requireRole(["manager", "admin"]) / managerApiContext.
 */

/** null = every rider (an admin's scope). */
export async function scopedRiderIds(scope: ManagerScope): Promise<Set<string> | null> {
  const zoneIds = scopeZoneIds(scope);
  if (zoneIds === null) return null;
  const { data, error } = await createAdminClient()
    .from("staff_zones")
    .select("user_id, profiles!inner(role)")
    .in("zone_id", [...zoneIds])
    .eq("profiles.role", "driver")
    .overrideTypes<{ user_id: string }[]>();
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.user_id));
}

/** Is this a rider the caller may record cash for? A failed read is a no. */
export async function riderInScope(scope: ManagerScope, riderId: string): Promise<boolean> {
  try {
    const ids = await scopedRiderIds(scope);
    if (ids !== null) return ids.has(riderId);
    const { data, error } = await createAdminClient()
      .from("profiles")
      .select("id")
      .eq("id", riderId)
      .eq("role", "driver")
      .maybeSingle();
    return !error && data !== null;
  } catch {
    return false;
  }
}
