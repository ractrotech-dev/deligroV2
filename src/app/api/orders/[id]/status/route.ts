import { NextResponse } from "next/server";
import { featureOffResponse, vendorFeatureOn } from "@/lib/features/guards.server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { updateKitchenOrderStatus } from "@/lib/data-access/vendor-orders";
import { normalizeCancellationReason } from "@/lib/data-access/order-cancellation";

const ALLOWED = new Set(["kitchen", "ready", "cancelled"]);

/**
 * PATCH /api/orders/:id/status — restaurant kitchen transitions only.
 *
 * The gate is vendor *access*, not the `restaurant` role. Since commit be36941
 * a person can run a shop while their profile stays `customer` ("stay both" —
 * their role has to remain customer for order-insert RLS to let them shop), and
 * a role check refused every one of them: they passed the /vendor layout gate,
 * saw their orders on the board, and got a 403 on both Accept and Reject. The
 * board was decorative for that entire class of vendor.
 *
 * This is the cheap first door, not the lock. `updateKitchenOrderStatus`
 * re-checks `restaurants.owner_id` against the caller for this specific order,
 * so passing here still gets you nowhere near somebody else's kitchen.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!isSupabaseConfigured) {
    return NextResponse.json(
      { error: "backend_not_configured" },
      { status: 503 }
    );
  }

  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Throttled between authentication and authorization on purpose: the vendor
  // check below is itself a database round trip for a shop-owning customer, so
  // bounding the caller first keeps an authenticated flood from turning into
  // two queries per request. A kitchen moves orders by hand, so a minute's
  // worth of human work sits comfortably under this ceiling.
  const limit = await rateLimit(`order-status:${profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  if (!(await hasVendorAccess(profile))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { status?: string; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!body.status || !ALLOWED.has(body.status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  // Rejecting / cancelling is switchable per shop; accept and ready are core.
  if (body.status === "cancelled" && !(await vendorFeatureOn("vendor.reject_orders"))) {
    return featureOffResponse("vendor.reject_orders");
  }

  // Trimmed and capped here as well as in the database: the column's check
  // constraint would reject an over-long reason by failing the whole
  // cancellation, and a kitchen that pasted too much text should still be able
  // to reject the order.
  const reason =
    typeof body.reason === "string"
      ? normalizeCancellationReason(body.reason)
      : undefined;

  try {
    const ok = await updateKitchenOrderStatus(
      id,
      body.status as "kitchen" | "ready" | "cancelled",
      reason
    );
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return transitionErrorResponse(e);
  }
}

/** What a failed `updateKitchenOrderStatus` tells the client. */
function transitionErrorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : "server_error";
  if (message === "forbidden") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (message === "invalid_transition") {
    return NextResponse.json(
      { error: "invalid_transition" },
      { status: 409 }
    );
  }
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}
