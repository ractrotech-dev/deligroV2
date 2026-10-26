import "server-only";
import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { CashInputError } from "@/lib/data-access/rider-cash";
import { isFeatureOn } from "@/lib/features/flags.server";
import { featureOffResponse } from "@/lib/features/guards.server";

/**
 * The shared door of the `/api/rider/cash/*` routes, in order:
 *
 *   1. `requireRiderApi()` — 503 not_configured · 401 unauthenticated ·
 *      403 not_rider. The rider id is the session's; no route takes one.
 *   2. A per-rider, per-route rate limit (429): 60 a minute for reads, and a
 *      tight one for writes (`writePerMinute`) — a deposit or a dispute is a
 *      person's attention.
 *   3. `driver.cash` switched off for this rider -> 403 feature_disabled
 *      (`featureOffResponse`): the Cash screen is hidden in the app and the
 *      server refuses its figures and deposits too. Collecting cash on a
 *      delivery is not behind this door (the delivery action records it), so
 *      the switch never stops a cash order being completed; a manager records
 *      the handover instead.
 *
 * `cashRouteError` maps what the data layer throws: a malformed query
 * (`CashInputError`) is 400 with its code; a database without 0085 is 503
 * migration_pending; anything else an opaque 500 (`riderRouteError`).
 */
export async function riderCashGate(
  route: string,
  opts: { writePerMinute?: number } = {}
): Promise<{ ok: true; driverId: string } | { ok: false; response: Response }> {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth;
  const driverId = auth.profile.id;
  const limit = await rateLimit(`rider-cash:${route}:${driverId}`, opts.writePerMinute ?? 60, 60_000);
  if (!limit.ok) return { ok: false, response: tooManyRequests(limit) };
  if (!(await isFeatureOn("driver.cash", driverId))) {
    return { ok: false, response: featureOffResponse("driver.cash") };
  }
  return { ok: true, driverId };
}

export async function cashRouteError(
  error: unknown,
  ctx: { route: string; method: string; riderId: string; event?: string }
): Promise<Response> {
  if (error instanceof CashInputError) return NextResponse.json({ error: error.code }, { status: 400 });
  return riderRouteError(error, ctx);
}

/** The JSON answer: never cached (it is one rider's cash, and it changes). */
export function cashJson(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
