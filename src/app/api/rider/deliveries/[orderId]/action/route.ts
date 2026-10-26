import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { performDeliveryAction } from "@/lib/data-access/rider-delivery-actions";
import {
  isMethodFor,
  isRiderAction,
  type DeliverMethod,
  type PickupMethod,
} from "@/lib/rider/delivery-machine";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What `uploadDeliveryProof` returns: `<deliveryId>/<uuid>.<jpg|png>`. */
const PROOF_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png)$/i;

/**
 * POST /api/rider/deliveries/:orderId/action
 *   { action, actionId, code?, method?, photoPath?, lat?, lng? }
 *
 * One step on the delivery the rider holds: arrive_pickup, pickup (method code
 * | qr | manual), start_trip, arrive_drop, deliver (method code | photo |
 * ops_approved; `code` is the plain "Delivered"). Handover codes are retired:
 * a `code` an older app still sends is accepted and ignored. `actionId` is the app's UUID
 * for the tap: a replay of the same tap is answered `{ ok: true, duplicate:
 * true }` and changes nothing. `lat`/`lng`, when given and plausible, are
 * recorded on the step's event. The rider is the session's; the order is the
 * URL's; whether the rider holds it is decided on the server.
 *
 *   200 { ok: true, duplicate? }
 *   400 invalid_order | invalid_body | invalid_action | invalid_action_id
 *       | invalid_method | invalid_code | invalid_photo | invalid_position
 *   404 not_found           not this rider's delivery (same answer as none at all)
 *   409 bad_state | order_not_active | photo_required | manual_not_approved
 *   503 migration_pending   a step that needs 0081/0082 on a database without it
 *
 * Rate limit: 30 steps a minute per rider.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Before any field is validated, so a malformed request still spends.
  const limit = await rateLimit(`rider-action:${profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { action, actionId, code, method, photoPath, lat, lng } = body;
  if (!isRiderAction(action)) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  if (typeof actionId !== "string" || !UUID.test(actionId)) {
    return NextResponse.json({ error: "invalid_action_id" }, { status: 400 });
  }
  if (!isMethodFor(action, method)) return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  if (code !== undefined && code !== null && (typeof code !== "string" || code.length > 16)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }
  if (photoPath !== undefined && photoPath !== null && (typeof photoPath !== "string" || !PROOF_PATH.test(photoPath))) {
    return NextResponse.json({ error: "invalid_photo" }, { status: 400 });
  }
  const hasPosition = lat !== undefined && lat !== null;
  if (hasPosition !== (lng !== undefined && lng !== null)) {
    return NextResponse.json({ error: "invalid_position" }, { status: 400 });
  }
  if (hasPosition && (typeof lat !== "number" || typeof lng !== "number")) {
    return NextResponse.json({ error: "invalid_position" }, { status: 400 });
  }

  try {
    const result = await performDeliveryAction(profile.id, orderId, {
      action,
      actionId,
      code: typeof code === "string" ? code : undefined,
      method: (method ?? undefined) as PickupMethod | DeliverMethod | undefined,
      photoPath: typeof photoPath === "string" ? photoPath : undefined,
      lat: typeof lat === "number" ? lat : undefined,
      lng: typeof lng === "number" ? lng : undefined,
    });
    if (!result.ok) {
      if (result.error === "not_yours") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json(result.duplicate ? { ok: true, duplicate: true } : { ok: true });
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/deliveries/[orderId]/action",
      method: "POST",
      riderId: profile.id,
      event: action,
    });
  }
}
