import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { onlinePaymentsEnabled } from "@/lib/payments/availability";
import {
  createRazorpayOrder,
  razorpayPublicKeyId,
  toPaise,
  RazorpayError,
} from "@/lib/payments/razorpay";
import {
  findReusablePayment,
  getOrderPaymentContext,
  recordPaymentIntent,
  PaymentsNotMigratedError,
  type OrderPaymentContext,
} from "@/lib/data-access/payments";

/**
 * Why this order cannot be charged online right now, or null when it can.
 * Checked in this order; the first refusal wins.
 */
function notPayableOnline(
  order: OrderPaymentContext
): { error: string; status: number } | null {
  if (order.paymentMethod !== "online") {
    return { error: "not_an_online_order", status: 400 };
  }
  if (order.paymentStatus !== "pending") {
    return { error: "already_settled", status: 409 };
  }
  if (order.status === "cancelled") {
    return { error: "order_cancelled", status: 409 };
  }
  if (order.total <= 0) {
    return { error: "invalid_amount", status: 400 };
  }
  return null;
}

/**
 * POST /api/payments/razorpay/order — open a Razorpay order for an order we
 * have already placed and priced.
 *
 * The amount is read from `orders.total`, which `recompute_order_total()` wrote
 * from the database's own menu prices. Nothing the client sends influences what
 * is charged; the body carries an order id and nothing else.
 *
 * 503s while online payment is switched off, which is the state the feature
 * ships in — the customer app shows "Available soon" and never calls this.
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimit(`pay-create:${user.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  // Checked after auth so an unauthenticated prod scan can't map the feature,
  // and before any Razorpay call so a disabled install never reaches the API.
  if (!(await onlinePaymentsEnabled())) {
    return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
  }

  let body: { orderId?: string };
  try {
    body = (await request.json()) as { orderId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body?.orderId) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    // RLS-scoped: a foreign order id is indistinguishable from a missing one.
    const order = await getOrderPaymentContext(body.orderId);
    if (!order) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const refusal = notPayableOnline(order);
    if (refusal) {
      return NextResponse.json({ error: refusal.error }, { status: refusal.status });
    }

    const amountPaise = toPaise(order.total);

    // A second tap re-opens the attempt already in flight rather than minting a
    // parallel Razorpay order for the same money.
    const existing = await findReusablePayment(order.id, amountPaise);
    if (existing) {
      return NextResponse.json({
        keyId: razorpayPublicKeyId(),
        orderId: order.id,
        providerOrderId: existing.providerOrderId,
        amountPaise: existing.amountPaise,
        currency: existing.currency,
      });
    }

    const rzpOrder = await createRazorpayOrder({
      amountPaise,
      currency: "INR",
      // Razorpay caps the receipt at 40 characters; a uuid is 36.
      receipt: order.id,
      notes: { deligro_order_id: order.id },
    });

    await recordPaymentIntent({
      orderId: order.id,
      providerOrderId: rzpOrder.id,
      amountPaise,
      currency: rzpOrder.currency ?? "INR",
    });

    return NextResponse.json({
      keyId: razorpayPublicKeyId(),
      orderId: order.id,
      providerOrderId: rzpOrder.id,
      amountPaise,
      currency: rzpOrder.currency ?? "INR",
    });
  } catch (err) {
    if (err instanceof PaymentsNotMigratedError) {
      return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
    }
    if (err instanceof RazorpayError) {
      return NextResponse.json({ error: "gateway_error" }, { status: err.status });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
