import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_ZONE, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";

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
  const supabase = createAdminClient();
  // Paged: a bare select stops at PostgREST's 1,000 rows without saying so,
  // and a town with more riders than that would silently lose the rest.
  const { data, error } = await readAllRows<{ user_id: string }>((from, to) =>
    supabase
      .from("staff_zones")
      .select("user_id, profiles!inner(role)")
      .in("zone_id", [...zoneIds])
      .eq("profiles.role", "driver")
      .order("user_id")
      .order("zone_id")
      .range(from, to) as unknown as PromiseLike<{ data: { user_id: string }[] | null; error: unknown }>
  );
  if (error) throw error;
  return new Set(data.map((r) => r.user_id));
}

/**
 * The zone filter for the `ops_*_scoped` views (0153): each row carries its
 * rider's zone ids, so the scope travels as the manager's few zones instead of
 * every rider id in them. null = an admin (no filter).
 */
export function riderZoneFilter(scope: ManagerScope): string[] | null {
  const zones = scopeZoneIds(scope);
  if (zones === null) return null;
  return zones.length > 0 ? [...zones] : [NO_ZONE];
}

/**
 * `select cols from table where column in ids [and key in values …]`, chunked
 * so no URL grows with the id list. Throws on the first error.
 */
export async function readByIds<T>(
  table: string,
  cols: string,
  column: string,
  ids: readonly string[],
  alsoIn: Readonly<Record<string, readonly string[]>> = {}
): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const supabase = createAdminClient();
  const { data, error } = await readInChunks<T>(unique, (chunk) => {
    let q = supabase.from(table).select(cols).in(column, chunk);
    for (const [key, values] of Object.entries(alsoIn)) q = q.in(key, [...values]);
    return q as unknown as PromiseLike<{ data: T[] | null; error: unknown }>;
  });
  if (error) throw error;
  return data;
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
