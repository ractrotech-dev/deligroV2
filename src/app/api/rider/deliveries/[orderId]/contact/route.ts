import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { logContactAttempt } from "@/lib/data-access/rider-delivery-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rider/deliveries/:orderId/contact   { target: "customer" | "vendor" }
 *
 * The app calls this when the rider taps Call: a `contact_attempt` event is
 * written for the delivery they hold. It is what "I called and nobody
 * answered" rests on — `customer_unreachable` can only be raised after one.
 * Nothing is dialled from here; the phone does that.
 *
 *   200 { ok: true }
 *   400 invalid_order | invalid_body | invalid_target
 *   404 not_found           not this rider's delivery
 *   409 bad_state           the delivery is no longer live
 *   503 migration_pending   no delivery_events / contact_attempt kind (0081/0082)
 *
 * Rate limit: 20 a minute per rider.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-contact:${profile.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  let body: { target?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const target = body && typeof body === "object" ? body.target : undefined;
  if (target !== "customer" && target !== "vendor") {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }

  try {
    const result = await logContactAttempt(profile.id, orderId, target);
    if (!result.ok) {
      if (result.error === "not_yours") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/deliveries/[orderId]/contact",
      method: "POST",
      riderId: profile.id,
      event: "contact_attempt",
    });
  }
}
