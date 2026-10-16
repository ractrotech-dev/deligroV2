import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { verifyCheckoutSignature } from "@/lib/payments/razorpay";
import {
  findPaymentByProviderOrderId,
  getOrderPaymentContext,
  settlePayment,
  PaymentsNotMigratedError,
} from "@/lib/data-access/payments";

/**
 * POST /api/payments/razorpay/verify — the browser checkout's success callback.
 *
 * This runs on the customer's own session, so every field in the body is
 * attacker-controlled until the HMAC matches. Three things are checked, in
 * order, and all three are load-bearing:
 *
 *   1. the caller owns the Deligro order (RLS, via getOrderPaymentContext),
 *   2. the signed Razorpay order actually belongs to THAT order — a valid
 *      signature proves a payment happened, not which of our orders it paid,
 *   3. the signature verifies against our key secret.
 *
 * The webhook remains the authority. This endpoint exists so the customer sees
 * a settled order immediately instead of waiting on a delivery that may be
 * seconds behind them — a webhook that arrives afterwards is a no-op.
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

  const limit = await rateLimit(`pay-verify:${user.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: {
    orderId?: string;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    signature?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { orderId, razorpayOrderId, razorpayPaymentId, signature } = body ?? {};
  if (!orderId || !razorpayOrderId || !razorpayPaymentId || !signature) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const order = await getOrderPaymentContext(orderId);
    if (!order) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const payment = await findPaymentByProviderOrderId(razorpayOrderId);
    // Same 404 for "no such attempt" and "someone else's attempt": which of the
    // two it is would itself be information about another customer's order.
    if (payment?.orderId !== order.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    if (
      !verifyCheckoutSignature({
        providerOrderId: razorpayOrderId,
        providerPaymentId: razorpayPaymentId,
        signature,
      })
    ) {
      // Recorded, not just refused: a failed signature against a real attempt is
      // worth having in the audit trail. signature_verified stays false.
      await settlePayment({
        providerOrderId: razorpayOrderId,
        providerPaymentId: razorpayPaymentId,
        status: "failed",
        signatureVerified: false,
        errorCode: "signature_mismatch",
        errorDescription: "Checkout signature did not verify.",
      });
      return NextResponse.json({ error: "signature_mismatch" }, { status: 400 });
    }

    await settlePayment({
      providerOrderId: razorpayOrderId,
      providerPaymentId: razorpayPaymentId,
      status: "paid",
      signatureVerified: true,
    });

    return NextResponse.json({ ok: true, orderId: order.id });
  } catch (err) {
    if (err instanceof PaymentsNotMigratedError) {
      return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
