import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { raiseException } from "@/lib/data-access/delivery-exceptions";
import { isExceptionKind } from "@/lib/rider/exception-rules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What `uploadDeliveryProof` builds: `<deliveryId>/<uuid>.<jpg|png>`. */
const PHOTO_PATH =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/i;
const REASON_MAX = 200;
const NOTES_MAX = 500;

/**
 * POST /api/rider/exceptions
 *   { orderId, kind, reason, notes?, photoPath?, lat?, lng? }
 *
 * The rider asks ops for a decision on the job they hold — or reports
 * something — from the app's "Can't deliver?" / "Report a problem" sheets.
 * Ops see it on the manager board and the admin live board, and their phones
 * ring for a request. The rider id is the session's; nothing in the body names
 * a rider.
 *
 *   201 { ok: true, id }
 *   400 invalid_body | invalid_order | invalid_kind | invalid_reason |
 *       invalid_notes | invalid_photo_path | invalid_position
 *   401 unauthenticated · 403 not_rider (requireRiderApi)
 *   404 not_found            not this rider's delivery (or offer)
 *   409 bad_state            not from where the job is (e.g. manual_pickup after pickup)
 *       call_first           customer_unreachable without a logged call since arriving
 *       wait_longer          { minutesLeft } — the admin-set wait at the door
 *       duplicate_pending    the same request is already with ops
 *       bad_photo            the photo is not this delivery's uploaded proof
 *   429 rate limited
 *   503 migration_pending    delivery_exceptions (0082) is not applied
 *
 * Rate limit: 10 a minute per rider — a request is a person's attention.
 */
export async function POST(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-exception:${profile.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

  const { orderId, kind, reason, notes, photoPath, lat, lng } = body;
  if (!isExceptionKind(kind)) return bad("invalid_kind");
  if (typeof orderId !== "string" || !UUID.test(orderId)) return bad("invalid_order");
  if (typeof reason !== "string" || !reason.trim() || reason.length > REASON_MAX) return bad("invalid_reason");
  if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > NOTES_MAX)) {
    return bad("invalid_notes");
  }
  if (photoPath !== undefined && photoPath !== null && (typeof photoPath !== "string" || !PHOTO_PATH.test(photoPath))) {
    return bad("invalid_photo_path");
  }
  const hasLat = lat !== undefined && lat !== null;
  const hasLng = lng !== undefined && lng !== null;
  if (hasLat !== hasLng || (hasLat && (typeof lat !== "number" || typeof lng !== "number"))) {
    return bad("invalid_position");
  }

  try {
    const result = await raiseException(profile.id, {
      orderId,
      kind,
      reason,
      notes: typeof notes === "string" ? notes : undefined,
      photoPath: typeof photoPath === "string" ? photoPath : undefined,
      lat: hasLat ? (lat as number) : undefined,
      lng: hasLng ? (lng as number) : undefined,
    });
    if (result.ok) return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
    switch (result.error) {
      case "not_yours":
        // §2: the same answer for "not yours" and "no such order".
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      case "invalid_kind":
        return bad("invalid_kind");
      case "wait_longer":
        return NextResponse.json({ error: "wait_longer", minutesLeft: result.minutesLeft }, { status: 409 });
      default:
        return NextResponse.json({ error: result.error }, { status: 409 });
    }
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/exceptions",
      method: "POST",
      riderId: profile.id,
      event: "raise_exception",
    });
  }
}
