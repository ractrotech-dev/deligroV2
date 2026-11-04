import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { cancelDeliveryForOrder } from "@/lib/dispatch/rider-dispatch";
import { captureError } from "@/lib/obs/emit";
import {
  notifyOrderCancelled,
  notifyVendorOrderCancelled,
} from "@/lib/notifications/order-events";
import { deferNotify } from "@/lib/notifications/defer";

/**
 * POST /api/orders/:id/cancel — a customer cancels their own order.
 *
 * The rule book: only within 20 seconds of placing it. After that the order will
 * be delivered. The decision belongs to the database (customer_cancel_order, 0191):
 * it runs on the customer's own session, checks the order is theirs and the shop
 * has not taken it, and compares `created_at` with the database's clock against
 * `platform_settings.customer_cancel_seconds`. Nothing here, and nothing on the
 * phone, gets a say.
 *
 * Fails closed: without 0191 the function is missing and every request is refused
 * with `server_error`. Staff can still cancel.
 *
 * No refund is raised. An order paid online stays `paid`: what happens to that money
 * is an open question in the rule book.
 *
 *   200 { ok: true }
 *   401 unauthorized · 404 not_found (not yours, or no such order)
 *   409 too_late     · 429 · 500 server_error · 503 backend_not_configured
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSupabaseConfigured)
    return NextResponse.json(
      { error: "backend_not_configured" },
      { status: 503 }
    );
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = await rateLimit(`order-cancel:${user.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { data, error } = await supabase.rpc("customer_cancel_order", {
    p_order: id,
  });
  if (error) {
    const message = (error.message ?? "").trim();
    if (message === "too_late")
      return NextResponse.json({ error: "too_late" }, { status: 409 });
    // A malformed id is also "no such order": never leak the difference.
    if (message === "not_found" || error.code === "22P02")
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    captureError(error, { source: "order-cancel", orderId: id });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  // A repeat of a cancel that already worked: the people involved were told then.
  if ((data as { replayed?: boolean } | null)?.replayed === true) {
    return NextResponse.json({ ok: true });
  }

  // A rider may hold an offer on it. Best effort: the order IS cancelled, and this
  // function's own comment explains why a failure here must not undo that.
  await cancelDeliveryForOrder(id);

  // Fire-and-forget, by contract: order-events swallows its own failures. A push
  // outage must not fail a cancellation that has already happened.
  deferNotify(() => notifyOrderCancelled(id));
  deferNotify(() => notifyVendorOrderCancelled(id));

  return NextResponse.json({ ok: true });
}
