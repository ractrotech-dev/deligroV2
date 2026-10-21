"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isUuid, slugify, validateZoneInput, type ZoneInput } from "@/lib/auth/manager-scope";
import { logOpsActionSafely } from "@/lib/data-access/ops-audit";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Cities, zones, and which manager works which zone (migration 0141).
 *
 * Admin-only, each re-gated here — a Server Action is a public endpoint —
 * rate-limited, and written to the ops audit log. Zones are configuration:
 * nothing else writes them.
 */

export interface ZoneActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase to manage zones.";
const NOT_MIGRATED = "Zones need migration 0141 applied first.";

async function gate(): Promise<{ adminId: string } | ZoneActionResult> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  const limit = await rateLimit(`zones:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes at once. Wait a moment." };
  return { adminId: admin.id };
}

function failure(error: { code?: string; message?: string } | null): ZoneActionResult {
  if (error?.code === "42P01" || /does not exist/.test(error?.message ?? "")) {
    return { ok: false, error: NOT_MIGRATED };
  }
  if (error?.code === "23505") return { ok: false, error: "That name is already used here." };
  return { ok: false, error: "Couldn't save. Try again." };
}

function done(): ZoneActionResult {
  revalidatePath("/admin/settings/zones");
  revalidatePath("/admin/settings/employees");
  return { ok: true };
}

export async function createCityAction(input: { name: string }): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Name must be 2–60 characters." };

  const { data, error } = await createAdminClient()
    .from("cities")
    .insert({ name, slug: slugify(name) })
    .select("id")
    .single();
  if (error) return failure(error);

  await logOpsActionSafely({
    actorId: g.adminId,
    action: "city.create",
    entityType: "city",
    entityId: (data as { id: string }).id,
    after: { name },
  });
  return done();
}

export async function createZoneAction(
  input: ZoneInput & { cityId: string }
): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(input.cityId)) return { ok: false, error: "Choose a city." };
  const v = validateZoneInput(input);
  if (!v.ok) return v;

  const { data, error } = await createAdminClient()
    .from("delivery_zones")
    .insert({
      city_id: input.cityId,
      name: v.value.name,
      slug: slugify(v.value.name),
      center_lat: v.value.centerLat,
      center_lng: v.value.centerLng,
      radius_km: v.value.radiusKm,
    })
    .select("id")
    .single();
  if (error) return failure(error);

  const zoneId = (data as { id: string }).id;
  await logOpsActionSafely({
    actorId: g.adminId,
    action: "zone.create",
    entityType: "zone",
    entityId: zoneId,
    zoneId,
    after: v.value,
  });
  return done();
}

export async function updateZoneAction(
  input: ZoneInput & { id: string; isActive: boolean }
): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(input.id)) return { ok: false, error: "Unknown zone." };
  const v = validateZoneInput(input);
  if (!v.ok) return v;

  const db = createAdminClient();
  const { data: before } = await db
    .from("delivery_zones")
    .select("name, center_lat, center_lng, radius_km, is_active, is_default")
    .eq("id", input.id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Unknown zone." };
  // Shops and orders land in the default zone when nothing else says where;
  // switching it off would leave them nowhere a manager is assigned.
  if ((before as { is_default: boolean }).is_default && !input.isActive) {
    return { ok: false, error: "The default zone can't be switched off." };
  }

  const after = {
    name: v.value.name,
    center_lat: v.value.centerLat,
    center_lng: v.value.centerLng,
    radius_km: v.value.radiusKm,
    is_active: input.isActive,
  };
  const { error } = await db.from("delivery_zones").update(after).eq("id", input.id);
  if (error) return failure(error);

  await logOpsActionSafely({
    actorId: g.adminId,
    action: "zone.update",
    entityType: "zone",
    entityId: input.id,
    zoneId: input.id,
    before,
    after,
  });
  return done();
}

/** Replace the set of zones a manager works. Refuses anyone who isn't a manager. */
export async function setManagerZonesAction(input: {
  managerId: string;
  zoneIds: string[];
}): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(input.managerId)) return { ok: false, error: "Unknown manager." };
  const zoneIds = [...new Set(Array.isArray(input.zoneIds) ? input.zoneIds : [])];
  if (!zoneIds.every(isUuid)) return { ok: false, error: "Unknown zone." };

  const db = createAdminClient();
  const { data: person } = await db
    .from("profiles")
    .select("role")
    .eq("id", input.managerId)
    .maybeSingle();
  if ((person as { role?: string } | null)?.role !== "manager") {
    return { ok: false, error: "Zones are assigned to managers only." };
  }

  const { data: current, error: readErr } = await db
    .from("staff_zones")
    .select("zone_id")
    .eq("user_id", input.managerId);
  if (readErr) return failure(readErr);
  const before = ((current ?? []) as { zone_id: string }[]).map((r) => r.zone_id).sort();

  const remove = before.filter((z) => !zoneIds.includes(z));
  const add = zoneIds.filter((z) => !before.includes(z));
  if (remove.length > 0) {
    const { error } = await db
      .from("staff_zones")
      .delete()
      .eq("user_id", input.managerId)
      .in("zone_id", remove);
    if (error) return failure(error);
  }
  if (add.length > 0) {
    const { error } = await db
      .from("staff_zones")
      .insert(add.map((zoneId) => ({ user_id: input.managerId, zone_id: zoneId, assigned_by: g.adminId })));
    if (error) return failure(error);
  }

  await logOpsActionSafely({
    actorId: g.adminId,
    action: "manager.zones_set",
    entityType: "profile",
    entityId: input.managerId,
    before: { zoneIds: before },
    after: { zoneIds: [...zoneIds].sort() },
  });
  return done();
}
