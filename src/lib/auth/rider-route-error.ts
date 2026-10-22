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

/** The database error behind a wrapped one (`RiderSchemaPendingError.cause`), as telemetry attributes (`code`, `reason`: keys the obs allowlist already carries). */
function causeAttrs(error: unknown): Record<string, string> {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause === undefined || cause === null) return {};
  if (typeof cause !== "object") return { reason: String(cause).slice(0, 300) };
  const { code, message } = cause as { code?: unknown; message?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { reason: message.slice(0, 300) } : {}),
  };
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
    attrs: { event: ctx.event ?? "rider_route_error", ...causeAttrs(error) },
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
  // 0151's guard: ops suspended or rejected this rider while the request was
  // in flight (the gate in rider-api.ts passed a moment earlier). The answer
  // the gate itself would have given, not an opaque 500.
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && /rider_cannot_work/.test(message)) {
    return NextResponse.json({ error: "account_suspended" }, { status: 403 });
  }
  const pending = isRiderSchemaPending(error);
  const status = pending ? 503 : 500;
  await reportRiderError(error, { ...ctx, status });
  return NextResponse.json(
    { error: pending ? "migration_pending" : "server_error" },
    { status }
  );
}
