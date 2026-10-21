import "server-only";
import { NextResponse } from "next/server";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { captureError } from "@/lib/obs/emit";
import { obsRequestContext } from "@/lib/obs/request";

// Kept apart from `rider-api.ts` (which pulls in the session machinery) so the
// QA script can exercise it without a Next request scope.

/** Where a rider-path failure happened, for the telemetry row. */
export interface RiderErrorContext {
  /** The templated route, e.g. "/api/rider/location". */
  route: string;
  method: string;
  /** The signed-in rider (profile.id), the same raw id `api/orders` records as actorId. */
  riderId?: string | null;
  /** The status the caller answers with. */
  status?: number;
  /** What was being attempted when it failed, e.g. "fix" or "stamp". */
  event?: string;
}

/**
 * Record a failure on the rider path (`captureError`: never throws, never
 * blocks the response). Until this existed a 500 from /api/rider/* left no
 * trace anywhere: the response body is deliberately opaque, so the server log
 * is the only place the cause can live. The ids are the session's profile id —
 * the same convention as `api/orders` — and the message is redacted by emit.
 */
export async function reportRiderError(
  error: unknown,
  ctx: RiderErrorContext
): Promise<void> {
  const obs = await obsRequestContext();
  captureError(error, {
    source: ctx.route,
    httpMethod: ctx.method,
    httpRoute: ctx.route,
    httpStatus: ctx.status ?? null,
    requestId: obs.requestId,
    traceId: obs.traceId,
    actorRole: "driver",
    actorId: ctx.riderId ?? null,
    driverId: ctx.riderId ?? null,
    attrs: { event: ctx.event ?? "rider_route_error" },
  });
}

/**
 * The answer for a failure inside a rider route. A database without migration
 * 0081 is a known, fail-closed state (503 migration_pending); anything else is
 * an opaque 500 — the error itself stays server-side, in telemetry.
 */
export async function riderRouteError(
  error: unknown,
  ctx: Omit<RiderErrorContext, "status">
): Promise<NextResponse> {
  const pending = isRiderSchemaPending(error);
  const status = pending ? 503 : 500;
  await reportRiderError(error, { ...ctx, status });
  return NextResponse.json(
    { error: pending ? "migration_pending" : "server_error" },
    { status }
  );
}
