import "server-only";
import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isFeatureOn } from "@/lib/features/flags.server";
import { featureOffResponse } from "@/lib/features/guards.server";
import { EarningsInputError } from "@/lib/data-access/rider-earnings";

/**
 * The shared door of the five `/api/rider/earnings/*` routes, in order:
 *
 *   1. `requireRiderApi()` — 503 not_configured · 401 unauthenticated ·
 *      403 not_rider. The rider id is the session's; no route takes one.
 *   2. 60 requests a minute per rider per route (429). They are reads, but
 *      each one reads the rider's ledger.
 *   3. `driver.earnings` switched off for this rider -> 403 feature_disabled
 *      (`featureOffResponse`): the money tab is hidden in the app, and the
 *      server refuses the figures as well rather than trusting the app to.
 *
 * `earningsRouteError` maps what the data layer throws: a malformed query
 * (`EarningsInputError`) is 400 with its code; a database without 0083 is 503
 * migration_pending; anything else an opaque 500 (`riderRouteError`).
 */
export async function riderEarningsGate(
  route: string
): Promise<{ ok: true; driverId: string } | { ok: false; response: Response }> {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth;
  const driverId = auth.profile.id;

  const limit = await rateLimit(`rider-earnings:${route}:${driverId}`, 60, 60_000);
  if (!limit.ok) return { ok: false, response: tooManyRequests(limit) };

  if (!(await isFeatureOn("driver.earnings", driverId))) {
    return { ok: false, response: featureOffResponse("driver.earnings") };
  }
  return { ok: true, driverId };
}

export async function earningsRouteError(error: unknown, route: string, riderId: string): Promise<Response> {
  if (error instanceof EarningsInputError) {
    return NextResponse.json({ error: error.code }, { status: 400 });
  }
  return riderRouteError(error, { route, method: "GET", riderId });
}

/** The JSON answer: never cached (it is one rider's money, and it changes). */
export function earningsJson(body: unknown): Response {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
