import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { acceptOffer } from "@/lib/data-access/rider-jobs";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyVendorRiderAssigned, stopRiderRing } from "@/lib/notifications/order-events";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rider/offers/:orderId/accept
 *
 * The rider taking a ready order, through the same `acceptDelivery` as the web
 * portal. No body: the rider is the session's, the order is the URL's, and
 * whether it is theirs to take is decided on the server (online, ready, not
 * held for someone else, not taken).
 *
 *   200 { ok: true }
 *   400 invalid_order
 *   409 not_online | reserved | offer_expired | already_taken | not_ready
 *       `reserved`: held for another rider; `offer_expired`: this rider's own
 *       window ran out and it went to someone else.
 *   503 migration_pending   no rider_status (0081): the server cannot tell the
 *                           rider is online, so it does not guess.
 *
 * Rate limit shares its key with the web action (`driver-accept:<rider>`), so
 * the two doors together are 30 a minute.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`driver-accept:${profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  try {
    const result = await acceptOffer(profile.id, orderId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

    // As the web action does: the kitchen learns who is coming for the bag, and
    // this rider's phones stop ringing for the order.
    deferNotify(() => notifyVendorRiderAssigned(orderId, profile.full_name));
    deferNotify(() => stopRiderRing(profile.id, orderId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/offers/[orderId]/accept",
      method: "POST",
      riderId: profile.id,
    });
  }
}
