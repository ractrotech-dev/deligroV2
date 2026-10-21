"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isUuid, slugify, validateZoneInput, type ZoneInput } from "@/lib/auth/manager-scope";
import { rateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Cities, zones, and which staff work which zone (migration 0141).
 *
 * Admin-only, each re-gated here — a Server Action is a public endpoint —
 * and rate-limited. Every write is one RPC (`ops_create_city`,
 * `ops_create_zone`, `ops_update_zone`, `ops_set_staff_zones`) that makes the
 * change and writes its ops-audit entry in the same transaction, so a change
 * can never land without its record. The RPCs re-check that the actor is an
 * admin; they are executable by the service role only.
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
  const message = error?.message ?? "";
  if (error?.code === "42P01" || error?.code === "PGRST202" || /does not exist/.test(message)) {
    return { ok: false, error: NOT_MIGRATED };
  }
  if (error?.code === "23505") return { ok: false, error: "That name is already used here." };
  if (/default_zone_required/.test(message)) {
    // Shops and orders land in the default zone when nothing else says where.
    return { ok: false, error: "The default zone can't be switched off." };
  }
  if (/not_staff/.test(message)) return { ok: false, error: "Zones are assigned to managers and riders only." };
  if (/not_found/.test(message)) return { ok: false, error: "Unknown zone." };
  if (error?.code === "23503") return { ok: false, error: "Unknown zone." };
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

  const { error } = await createAdminClient().rpc("ops_create_city", {
    p_actor: g.adminId,
    p_name: name,
    p_slug: slugify(name),
  });
  return error ? failure(error) : done();
}

export async function createZoneAction(
  input: ZoneInput & { cityId: string }
): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(input.cityId)) return { ok: false, error: "Choose a city." };
  const v = validateZoneInput(input);
  if (!v.ok) return v;

  const { error } = await createAdminClient().rpc("ops_create_zone", {
    p_actor: g.adminId,
    p_city: input.cityId,
    p_name: v.value.name,
    p_slug: slugify(v.value.name),
    p_lat: v.value.centerLat,
    p_lng: v.value.centerLng,
    p_radius: v.value.radiusKm,
  });
  return error ? failure(error) : done();
}

export async function updateZoneAction(
  input: ZoneInput & { id: string; isActive: boolean }
): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(input.id)) return { ok: false, error: "Unknown zone." };
  const v = validateZoneInput(input);
  if (!v.ok) return v;

  const { error } = await createAdminClient().rpc("ops_update_zone", {
    p_actor: g.adminId,
    p_zone: input.id,
    p_name: v.value.name,
    p_lat: v.value.centerLat,
    p_lng: v.value.centerLng,
    p_radius: v.value.radiusKm,
    p_active: input.isActive === true,
  });
  return error ? failure(error) : done();
}

/**
 * Replace the set of zones a manager or rider works. A manager sees orders
 * in their zones and the riders who share one of them; the RPC refuses
 * anyone who is neither.
 */
export async function setManagerZonesAction(input: {
  managerId: string;
  zoneIds: string[];
}): Promise<ZoneActionResult> {
  const g = await gate();
  if ("ok" in g) return g;
  if (!isUuid(input.managerId)) return { ok: false, error: "Unknown person." };
  const zoneIds = [...new Set(Array.isArray(input.zoneIds) ? input.zoneIds : [])];
  if (!zoneIds.every(isUuid)) return { ok: false, error: "Unknown zone." };

  const { error } = await createAdminClient().rpc("ops_set_staff_zones", {
    p_actor: g.adminId,
    p_user: input.managerId,
    p_zone_ids: zoneIds,
  });
  return error ? failure(error) : done();
}
