import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { raiseSos } from "@/lib/data-access/sos";
import { readSupportBody } from "@/lib/support/request-body";
import { parseSos } from "@/lib/support/rules";

/**
 * POST /api/rider/sos — "Alert Deligro", or a safety report (§15).
 *
 *   JSON { kind, lat?, lng?, note?, orderId? }, or multipart with the same
 *   fields and up to 4 photos under `photos`.
 *   kind: alert | unsafe_situation | accident | vehicle_breakdown |
 *         harassment_threat | suspicious_order_location
 *
 *   201 { ok: true, ticketId, number, deduped: false, opsAlerted: true }
 *       A new emergency ticket; every manager and admin was pushed and rung.
 *   200 { ok: true, ticketId, number, deduped: true, opsAlerted: true }
 *       A tap within 10 minutes of the rider's open emergency: added to it as
 *       a location update (ops were already rung for it).
 *   400 invalid_body | invalid_kind | invalid_note | too_many_photos |
 *       photo_too_large | bad_photo_type
 *   401 · 403 not_rider · 429 · 503 migration_pending (0087) · 500
 *
 * Forgiving on purpose: a missing or implausible position, or an order that
 * is not the rider's, is dropped (the active delivery is used), never refused.
 * The app shows "Deligro ops have been alerted" only on a 2xx; anything else
 * it queues and retries with the last known location.
 *
 * This alerts Deligro staff only. It contacts no outside service and its
 * answer never says one was contacted — calling 112 is the phone's own call.
 *
 * Rate limit: 30 a minute per rider — panic tapping is expected and
 * deduplicated; the limit only stops a runaway client.
 */
export async function POST(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-sos:${profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const body = await readSupportBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const parsed = parseSos(body.fields);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const result = await raiseSos(profile.id, { ...parsed.value, attachments: body.files });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(
      { ok: true, ticketId: result.ticketId, number: result.number, deduped: result.deduped, opsAlerted: true },
      { status: result.deduped ? 200 : 201 }
    );
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/sos", method: "POST", riderId: profile.id, event: "sos" });
  }
}
