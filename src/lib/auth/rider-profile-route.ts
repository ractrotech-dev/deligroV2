import "server-only";
import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isFeatureOn } from "@/lib/features/flags.server";
import { featureOffResponse } from "@/lib/features/guards.server";

/**
 * The shared door of `/api/rider/profile*` and `/api/rider/documents*`, in order:
 *
 *   1. `requireRiderApi()` — 503 not_configured · 401 unauthenticated ·
 *      403 not_rider. The rider id is the session's; no route takes one from
 *      a body (a document id in a URL is looked up under that rider only).
 *   2. A rate limit per rider per route (429): uploads 10 a minute, everything
 *      else 30 — reads included, because each read returns personal data.
 *   3. For writes only: `driver.profile_edit` switched off for this rider ->
 *      403 feature_disabled (`featureOffResponse`). Reads still work, so a
 *      rider whose editing is switched off can still see what is on file.
 */
export async function riderProfileGate(
  route: string,
  opts: { write: boolean; perMinute: number }
): Promise<{ ok: true; driverId: string } | { ok: false; response: Response }> {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth;
  const driverId = auth.profile.id;

  const limit = await rateLimit(`rider-profile:${route}:${driverId}`, opts.perMinute, 60_000);
  if (!limit.ok) return { ok: false, response: tooManyRequests(limit) };

  if (opts.write && !(await isFeatureOn("driver.profile_edit", driverId))) {
    return { ok: false, response: featureOffResponse("driver.profile_edit") };
  }
  return { ok: true, driverId };
}

/** Personal data: never cached anywhere. */
export function profileJson(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** 503 migration_pending for a database without 0086; otherwise an opaque 500 (cause in telemetry). */
export function profileRouteError(error: unknown, route: string, method: string, riderId: string): Promise<Response> {
  return riderRouteError(error, { route, method, riderId });
}

/** A JSON body, or null when it is not JSON. */
export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
