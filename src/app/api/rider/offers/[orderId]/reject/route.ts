import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { rejectOffer } from "@/lib/data-access/rider-jobs";
import { isRejectReason } from "@/lib/rider/offer-window";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rider/offers/:orderId/reject  { reason, note? }
 *
 * The rider turning an offer down. `reason` is one of too_far, vehicle_issue,
 * on_break, low_battery, other; `note` is optional free text (kept to 200
 * characters). Only the rider the order is currently offered to may reject it.
 * The server records the rejection with the rider's position, withdraws the
 * offer, stops the ring and offers the order to the next rider - never back to
 * anyone who has already rejected it or let it lapse.
 *
 *   200 { ok: true }
 *   400 invalid_order | invalid_body | invalid_reason | invalid_note
 *   409 not_offered         not the current offeree (or the offer moved on)
 *   503 migration_pending   delivery_events (0081) is missing: the rejection
 *                           cannot be recorded, so it is not applied.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  const limit = await rateLimit(`rider-reject:${profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  let body: { reason?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!isRejectReason(body.reason)) {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400 });
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return NextResponse.json({ error: "invalid_note" }, { status: 400 });
  }

  try {
    const result = await rejectOffer(
      profile.id,
      orderId,
      body.reason,
      typeof body.note === "string" ? body.note : undefined
    );
    if (!result.ok) {
      const status = result.error === "invalid_reason" ? 400 : 409;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/offers/[orderId]/reject",
      method: "POST",
      riderId: profile.id,
    });
  }
}
