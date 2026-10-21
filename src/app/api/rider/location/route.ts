import { NextResponse } from "next/server";
import { requireRiderApi, riderRouteError } from "@/lib/auth/rider-api";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isRiderSchemaPending, recordRiderFix } from "@/lib/data-access/rider-status";

/**
 * POST /api/rider/location  { lat, lng }
 *
 * The rider's phone saying where it is, while the app is open. Online riders
 * keep their presence alive with it (a fix older than five minutes takes them
 * out of dispatch), and a rider with a delivery in flight also moves the dot
 * on the customer's map. An offline rider's position is acknowledged and
 * dropped — nothing is kept — which is why the answer says `online`.
 *
 *   200 { ok: true, online, active }   `active: false` means no delivery in flight
 *   400 invalid_body | invalid_position
 *   503 migration_pending   presence could not be recorded (no 0081). The body
 *                           still carries `active`: a delivery in flight HAS
 *                           had its position written, whatever happened to
 *                           presence — customer tracking does not depend on 0081.
 *   500 server_error        one of the two writes failed; `online`/`active`
 *                           say what did land.
 *
 * No delivery id and no rider id in the body: both come from the session.
 */
export async function POST(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  // Same ceiling as /api/driver/location: about 6 fixes a minute in normal use,
  // 30 for headroom, and a runaway watch loop capped at a write per two seconds.
  const limit = await rateLimit(`rider-location:${profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: { lat?: unknown; lng?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body.lat !== "number" || typeof body.lng !== "number") {
    return NextResponse.json({ error: "invalid_position" }, { status: 400 });
  }

  try {
    const result = await recordRiderFix(profile.id, body.lat, body.lng);
    if (!result.ok && result.error === "invalid_position") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (!result.ok) {
      const pending = isRiderSchemaPending(result.cause);
      return NextResponse.json(
        {
          error: pending ? "migration_pending" : "server_error",
          online: result.online,
          active: result.active,
        },
        { status: pending ? 503 : 500 }
      );
    }
    return NextResponse.json({ ok: true, online: result.online, active: result.active });
  } catch (e) {
    return riderRouteError(e);
  }
}
