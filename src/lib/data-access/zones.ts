import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ManagerScope } from "@/lib/auth/manager-scope";

/**
 * Cities, delivery zones and who works which zone (migration 0141).
 *
 * Service-role reads: every caller is behind managerApiContext() or
 * requireRole("admin") (AGENTS.md rule 5). Writes live in the admin actions.
 */

export interface Zone {
  id: string;
  cityId: string;
  name: string;
  slug: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  isActive: boolean;
  isDefault: boolean;
}

export interface CityZones {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  zones: Zone[];
}

interface ZoneRow {
  id: string;
  city_id: string;
  name: string;
  slug: string;
  center_lat: number;
  center_lng: number;
  radius_km: number | string;
  is_active: boolean;
  is_default: boolean;
}

function mapZone(r: ZoneRow): Zone {
  return {
    id: r.id,
    cityId: r.city_id,
    name: r.name,
    slug: r.slug,
    centerLat: Number(r.center_lat),
    centerLng: Number(r.center_lng),
    radiusKm: Number(r.radius_km),
    isActive: r.is_active,
    isDefault: r.is_default,
  };
}

/** Every city with its zones, ordered by name. */
export async function listCitiesWithZones(): Promise<CityZones[]> {
  const db = createAdminClient();
  const [{ data: cities, error: cErr }, { data: zones, error: zErr }] = await Promise.all([
    db.from("cities").select("id, name, slug, is_active").order("name"),
    db
      .from("delivery_zones")
      .select("id, city_id, name, slug, center_lat, center_lng, radius_km, is_active, is_default")
      .order("name"),
  ]);
  if (cErr) throw cErr;
  if (zErr) throw zErr;
  const byCity = new Map<string, Zone[]>();
  for (const z of (zones ?? []) as ZoneRow[]) {
    const list = byCity.get(z.city_id) ?? [];
    list.push(mapZone(z));
    byCity.set(z.city_id, list);
  }
  return ((cities ?? []) as { id: string; name: string; slug: string; is_active: boolean }[]).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    isActive: c.is_active,
    zones: byCity.get(c.id) ?? [],
  }));
}

/** The zone ids a person is assigned to. */
export async function listStaffZoneIds(userId: string): Promise<string[]> {
  const { data, error } = await createAdminClient()
    .from("staff_zones")
    .select("zone_id")
    .eq("user_id", userId);
  if (error) throw error;
  return ((data ?? []) as { zone_id: string }[]).map((r) => r.zone_id);
}

/** Zone assignments for many people at once (Team screen). */
export async function listStaffZonesFor(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const { data, error } = await createAdminClient()
    .from("staff_zones")
    .select("user_id, zone_id")
    .in("user_id", userIds);
  if (error) throw error;
  for (const r of (data ?? []) as { user_id: string; zone_id: string }[]) {
    out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.zone_id]);
  }
  return out;
}

/** The cities and zones a scope covers — what `/api/manager/me` reports. */
export function citiesInScope(all: CityZones[], scope: ManagerScope): CityZones[] {
  if (scope.all) return all;
  const allowed = new Set(scope.zoneIds);
  return all
    .map((c) => ({ ...c, zones: c.zones.filter((z) => allowed.has(z.id)) }))
    .filter((c) => c.zones.length > 0);
}
