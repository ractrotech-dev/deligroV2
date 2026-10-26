import "server-only";
import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isFeatureOn } from "@/lib/features/flags.server";
import { featureOffResponse } from "@/lib/features/guards.server";
import { InsightsInputError } from "@/lib/data-access/rider-insights";
import type { FeatureKey } from "@/lib/features/catalog";

/**
 * The shared door of the `/api/rider/{dashboard,history,performance,ratings}`
 * routes, in order:
 *
 *   1. `requireRiderApi()` - 503 not_configured · 401 unauthenticated ·
 *      403 not_rider. The rider id is the session's; no route takes one.
 *   2. 60 requests a minute per rider per route (429). They are reads, but each
 *      one reads the rider's events (Home polls every 15 s: 4 a minute).
 *   3. `feature` switched off for this rider -> 403 feature_disabled
 *      (`featureOffResponse`): History is hidden in the app when `driver.history`
 *      is off, and the server refuses it as well rather than trusting the app.
 *      Performance and ratings pass `driver.performance` the same way.
 *
 * `earnings` is whether `driver.earnings` is on for this rider. It is not a
 * gate: Home, History and Performance answer without money when it is off (the
 * data layer then never reads the ledger).
 *
 * `insightsRouteError` maps what the data layer throws: a malformed query
 * (`InsightsInputError`) is 400 with its code; a database without 0081 (or, for
 * ratings, 0084) is 503 migration_pending; anything else an opaque 500.
 */
export async function riderInsightsGate(
  route: string,
  opts: { feature?: FeatureKey } = {}
): Promise<{ ok: true; driverId: string; earnings: boolean } | { ok: false; response: Response }> {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth;
  const driverId = auth.profile.id;

  const limit = await rateLimit(`rider-insights:${route}:${driverId}`, 60, 60_000);
  if (!limit.ok) return { ok: false, response: tooManyRequests(limit) };

  if (opts.feature && !(await isFeatureOn(opts.feature, driverId))) {
    return { ok: false, response: featureOffResponse(opts.feature) };
  }
  return { ok: true, driverId, earnings: await isFeatureOn("driver.earnings", driverId) };
}

export async function insightsRouteError(error: unknown, route: string, riderId: string): Promise<Response> {
  if (error instanceof InsightsInputError) {
    return NextResponse.json({ error: error.code }, { status: 400 });
  }
  return riderRouteError(error, { route, method: "GET", riderId });
}

/** The JSON answer: never cached (it is one rider's work, and it changes). */
export function insightsJson(body: unknown): Response {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
