import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  requestRefund,
  type RefundRequestResult,
} from "@/lib/data-access/refunds";

/**
 * POST /api/refunds  { orderId, reason? } — a customer asks for their money back.
 *
 * The refunds table has had a customer-request RLS policy since 0001 and no way
 * for a customer to reach it: there was no endpoint, no button, and therefore no
 * queue. This is that way in.
 *
 * What the client does NOT get to send is the amount. It is read from
 * `orders.total` inside `requestRefund` — the one number a customer has an
 * obvious reason to choose for themselves, and since 0026 the insert policy
 * refuses anything above the order total even if this route were bypassed.
 *
 * Only a finished order can be refunded (delivered or cancelled). An order still
 * in the kitchen is cancelled, not refunded, and that path already returns the
 * money on its own.
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

  // `requestRefund` re-checks ownership under RLS; this stops one account
  // hammering the endpoint to work out which order ids exist. Keyed on the user
  // because there is no unauthenticated path through here.
  const limit = await rateLimit(`refund-request:${user.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: { orderId?: string; reason?: string };
  try {
    body = (await request.json()) as { orderId?: string; reason?: string };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  if (!orderId) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await requestRefund(orderId, reason);
  if (!result.ok) {
    // "not yours" and "does not exist" both leave here as 404 — requestRefund
    // returns the same answer for both, and the status must not undo that.
    const status = refundErrorStatus(result.error);
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true });
}

function refundErrorStatus(error: RefundRequestResult["error"]): number {
  if (error === "unauthorized") return 401;
  if (error === "not_found") return 404;
  if (error === "already_requested" || error === "invalid_state") return 409;
  return 500;
}
