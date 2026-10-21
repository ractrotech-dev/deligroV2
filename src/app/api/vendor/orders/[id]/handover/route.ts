import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { vendorConfirmHandover } from "@/lib/data-access/rider-delivery-actions";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { captureError } from "@/lib/obs/emit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/vendor/orders/:id/handover — "Handed to rider" on the kitchen board.
 *
 * The vendor's half of the pickup: it records the pickup on the shop's word
 * (`pickup_method = 'vendor'`), moves the order on the way, and tells the
 * customer and the rider. For a rider without the code, or a counter faster
 * than reading it out.
 *
 * Same door as PATCH /api/orders/:id/status: vendor *access* (a shop-owning
 * customer passes), throttled between authentication and authorization; then
 * `vendorConfirmHandover` checks that the caller owns THIS order's shop before
 * the service-role write — an admin, or another shop's owner, is refused.
 *
 *   200 { ok: true }                (also when it was already handed over)
 *   400 invalid_order
 *   401 unauthorized
 *   403 forbidden (no vendor access) | not_yours (not this shop's order)
 *   409 no_rider | bad_state        nobody holds it yet / not ready, or over
 *   503 backend_not_configured | migration_pending
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = await rateLimit(`vendor-handover:${profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  if (!(await hasVendorAccess(profile))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  try {
    const result = await vendorConfirmHandover(profile.id, id);
    if (!result.ok) {
      const status = result.error === "not_yours" ? 403 : 409;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const pending = isRiderSchemaPending(e);
    captureError(e, {
      source: "/api/vendor/orders/[id]/handover",
      httpMethod: "POST",
      httpRoute: "/api/vendor/orders/[id]/handover",
      httpStatus: pending ? 503 : 500,
      actorId: profile.id,
      orderId: id,
      attrs: { event: "vendor_handover" },
    });
    return NextResponse.json(
      { error: pending ? "migration_pending" : "server_error" },
      { status: pending ? 503 : 500 }
    );
  }
}
