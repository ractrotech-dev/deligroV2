import "server-only";
import { NextResponse } from "next/server";
import { getProfile, type Profile } from "@/lib/auth";
import { allOn, featuresFor, type FeatureKey, type FeatureMap } from "@/lib/features/catalog";
import { getFeatures } from "@/lib/features/flags.server";
import { listStaffZoneIds } from "@/lib/data-access/zones";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getPlatformLock, lockBlocksConsole } from "@/lib/platform-lock";
import { pausedText } from "@/lib/platform-lock-rules";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import type { ManagerScope } from "@/lib/auth/manager-scope";

/**
 * The gate every Manager-app route opens with.
 *
 *   503 not_configured     — no backend keys
 *   401 unauthenticated    — no session
 *   403 forbidden          — signed in, but not a manager or admin
 *   403 permission_denied  — a manager whose switch for `permission` is off
 *
 * On success: the profile, the zones they may see, and their permissions. An
 * admin has every zone and every permission. A manager's zones come from
 * `staff_zones`; if that read fails the scope is empty — they see nothing
 * rather than everything (AGENTS.md rule 2).
 */
export interface ManagerApiContext {
  profile: Profile;
  scope: ManagerScope;
  /** Manager switches only (`manager.*`). */
  permissions: Record<string, boolean>;
}

function managerPermissions(map: FeatureMap): Record<string, boolean> {
  return Object.fromEntries(
    featuresFor("manager").map((f) => [f.key, map[f.key as FeatureKey]])
  );
}

export async function managerApiContext(
  permission?: FeatureKey
): Promise<ManagerApiContext | Response> {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (profile.role !== "manager" && profile.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // The developer's full pause (0177): the Manager app shows the message.
  const lock = await getPlatformLock();
  if (lockBlocksConsole(lock, profile.role)) {
    return NextResponse.json({ error: "platform_paused", message: pausedText(lock) }, { status: 423 });
  }

  if (profile.role === "admin") {
    return { profile, scope: { all: true }, permissions: managerPermissions(allOn()) };
  }

  const [features, scope] = await Promise.all([
    getFeatures("manager", profile.id),
    staffScopeFor(profile),
  ]);
  const permissions = managerPermissions(features);

  if (permission && !permissions[permission]) {
    return NextResponse.json({ error: "permission_denied", permission }, { status: 403 });
  }

  return { profile, scope, permissions };
}

/**
 * The zones a signed-in person's service-role reads are limited to: everything
 * for an admin, their `staff_zones` for anyone else. A failed read is no zones
 * (fail closed). The web /manager portal uses this as the app's routes do.
 */
export async function staffScopeFor(profile: Pick<Profile, "id" | "role">): Promise<ManagerScope> {
  if (profile.role === "admin") return { all: true };
  const zoneIds = await listStaffZoneIds(profile.id).catch(() => [] as string[]);
  return { all: false, zoneIds };
}

/** Per-person write budget for manager routes. Null when within it. */
export async function managerWriteLimit(
  ctx: ManagerApiContext,
  bucket: string,
  limit = 60,
  windowMs = 60_000
): Promise<Response | null> {
  const result = await rateLimit(`mgr-${bucket}:${ctx.profile.id}`, limit, windowMs);
  return result.ok ? null : tooManyRequests(result);
}

/** A JSON body, or null for anything that isn't a JSON object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
