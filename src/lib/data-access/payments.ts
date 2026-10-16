import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  notifyPaymentFailed,
  notifyVendorNewOrder,
} from "@/lib/notifications/order-events";
import type { PaymentStatus } from "@/types";
import { deferNotify } from "@/lib/notifications/defer";
import { recordDomain } from "@/lib/obs/emit";
import { queueRefundForOrder } from "@/lib/data-access/refunds";
import {
  decideSettlement,
  shouldReapplyCapture,
  totalToPaise,
} from "@/lib/payments/settle-decision";

/**
 * Payment records (migration 0025).
 *
 * Reads ride RLS — a customer sees their own order's payments and nothing else.
 * Writes go through the service role, because `payments` deliberately has no
 * INSERT/UPDATE policy: the only thing allowed to say an order is paid is code
 * that has just verified a Razorpay signature. Every `createAdminClient()` call
 * below therefore has a signature check or an ownership check above it in the
 * same path — see the route handlers in src/app/api/payments/razorpay/.
 */

export interface OrderPaymentContext {
  id: string;
  total: number;
  status: string;
  paymentMethod: string;
  paymentStatus: PaymentStatus;
}

export class PaymentsNotMigratedError extends Error {
  constructor() {
    super("payments_not_migrated");
    this.name = "PaymentsNotMigratedError";
  }
}

function isMissingRelation(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    msg.includes("schema cache")
  );
}

/**
 * The order a payment is being taken for, scoped by RLS to the caller.
 *
 * Returns null when the order does not exist OR is not the caller's — the two
 * are indistinguishable on purpose, so the endpoint cannot be used to probe
 * which order ids exist.
 */
export async function getOrderPaymentContext(
  orderId: string
): Promise<OrderPaymentContext | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, total, status, payment_method, payment_status")
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) throw new PaymentsNotMigratedError();
    throw error;
  }
  if (!data) return null;

  return {
    id: data.id as string,
    total: Number(data.total ?? 0),
    status: String(data.status ?? ""),
    paymentMethod: String(data.payment_method ?? "cod"),
    paymentStatus: (data.payment_status ?? "pending") as PaymentStatus,
  };
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
}

function mapPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    providerOrderId: row.provider_order_id as string,
    providerPaymentId: (row.provider_payment_id as string | null) ?? null,
    amountPaise: Number(row.amount_paise ?? 0),
    currency: typeof row.currency === "string" ? row.currency : "INR",
    status: (row.status ?? "pending") as PaymentStatus,
  };
}

/**
 * An existing unpaid attempt for this order and amount, if there is one.
 *
 * Double-tapping "Pay" must not mint a second Razorpay order for the same
 * money: the first one stays open, both can be paid, and reconciling that is a
 * refund conversation. The amount is part of the match because a changed total
 * is a different bill and genuinely needs a new attempt.
 */
export async function findReusablePayment(
  orderId: string,
  amountPaise: number
): Promise<PaymentRecord | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, order_id, provider_order_id, provider_payment_id, amount_paise, currency, status"
    )
    .eq("order_id", orderId)
    .eq("amount_paise", amountPaise)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) throw new PaymentsNotMigratedError();
    throw error;
  }
  return data ? mapPayment(data) : null;
}

/**
 * The payment attempt behind a Razorpay order id.
 *
 * The verify route needs this to confirm the signed provider order actually
 * belongs to the Deligro order being settled. Without that check a customer
 * could pay for a ₹50 order, then replay the genuine (and genuinely valid)
 * signature against a ₹5,000 one — the HMAC would verify, because it says
 * nothing about which of our orders it was for.
 */
export async function findPaymentByProviderOrderId(
  providerOrderId: string
): Promise<PaymentRecord | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, order_id, provider_order_id, provider_payment_id, amount_paise, currency, status"
    )
    .eq("provider", "razorpay")
    .eq("provider_order_id", providerOrderId)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) throw new PaymentsNotMigratedError();
    throw error;
  }
  return data ? mapPayment(data) : null;
}

/** Record the Razorpay order we just created, before the customer pays it. */
export async function recordPaymentIntent(input: {
  orderId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
}): Promise<PaymentRecord> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("payments")
    .insert({
      order_id: input.orderId,
      provider: "razorpay",
      provider_order_id: input.providerOrderId,
      amount_paise: input.amountPaise,
      currency: input.currency,
      status: "pending",
    })
    .select(
      "id, order_id, provider_order_id, provider_payment_id, amount_paise, currency, status"
    )
    .single();

  if (error) {
    if (isMissingRelation(error)) throw new PaymentsNotMigratedError();
    throw error;
  }
  return mapPayment(data);
}

export interface SettleInput {
  providerOrderId: string;
  providerPaymentId?: string | null;
  status: PaymentStatus;
  method?: string | null;
  signatureVerified: boolean;
  errorCode?: string | null;
  errorDescription?: string | null;
}

/** The states each target state may be entered from. Terminal states are never left. */
const FROM: Record<PaymentStatus, PaymentStatus[]> = {
  pending: [],
  authorized: ["pending"],
  failed: ["pending", "authorized"],
  paid: ["pending", "authorized", "failed"],
  refunded: ["pending", "authorized", "failed"],
};

/**
 * Move a payment to its final state and mirror it onto the order.
 *
 * Idempotent, because it is called from two places that race by design: the
 * browser callback and the Razorpay webhook, and the webhook is retried until
 * we answer 2xx. Two rules make that safe:
 *
 *   - Every transition is a conditional UPDATE that names the states it may
 *     leave (`FROM`), and acts only if a row came back. The loser of a race
 *     therefore changes nothing and notifies nobody. A payment already 'paid'
 *     or 'refunded' is never walked backwards: a late "failed" for money we
 *     hold is a reconciliation problem, not a reason to tell the customer their
 *     paid order is unpaid.
 *   - Before an order is marked paid, what Razorpay took is compared with what
 *     the order costs now (see `decideSettlement`). Underpaid orders stay
 *     unpaid and raise an alert; orders that were cancelled while the customer
 *     was at the bank are marked paid and sent to the refund queue instead of
 *     ringing a kitchen.
 *
 * Returns the order id the payment belongs to, or null if the provider order is
 * unknown to us (which is what a forged or foreign webhook looks like).
 */
export async function settlePayment(input: SettleInput): Promise<string | null> {
  const supabase = createAdminClient();

  const { data: existing, error: readError } = await supabase
    .from("payments")
    .select("id, order_id, status, amount_paise, error_code")
    .eq("provider", "razorpay")
    .eq("provider_order_id", input.providerOrderId)
    .maybeSingle();

  if (readError) {
    if (isMissingRelation(readError)) throw new PaymentsNotMigratedError();
    throw readError;
  }
  if (!existing) return null;

  const orderId = existing.order_id as string;
  const current = existing.status as PaymentStatus;

  // The payment row goes 'paid' BEFORE the order is touched (the claim below is
  // what makes the two racing callers safe). If the order write then failed, the
  // webhook is retried — and without this branch the retry would see a row that
  // is already 'paid', acknowledge it, and leave the customer charged with an
  // order that is still 'pending' and a kitchen that was never told. So a repeat
  // 'paid' for a captured payment re-applies it when, and only when, the order
  // does not yet show it. A payment held as underpaid keeps its 'paid' row on
  // purpose (the money is real) and is not re-applied: that decision was made.
  if (current === "paid" && input.status === "paid") {
    if (existing.error_code !== "amount_mismatch") {
      const { data: ord, error: ordReadError } = await supabase
        .from("orders")
        .select("payment_status")
        .eq("id", orderId)
        .maybeSingle();
      if (ordReadError) throw ordReadError;
      if (
        shouldReapplyCapture({
          paymentRowStatus: current,
          incomingStatus: input.status,
          paymentErrorCode: existing.error_code as string | null,
          orderPaymentStatus: (ord?.payment_status as string | null) ?? null,
        })
      ) {
        await applyCapturedPayment(supabase, {
          orderId,
          paymentId: existing.id as string,
          capturedPaise: Number(existing.amount_paise ?? 0),
        });
      }
    }
    return orderId;
  }

  // Terminal-and-settled, or nothing new to record: acknowledge, do not re-apply.
  if (current === "paid" || current === "refunded") return orderId;
  if (current === input.status) return orderId;
  if (!FROM[input.status].includes(current)) return orderId;

  // The claim. Only the caller whose UPDATE returns a row owns this transition.
  const { data: claimed, error: updateError } = await supabase
    .from("payments")
    .update({
      provider_payment_id: input.providerPaymentId ?? null,
      status: input.status,
      method: input.method ?? null,
      signature_verified: input.signatureVerified,
      error_code: input.errorCode ?? null,
      error_description: input.errorDescription ?? null,
    })
    .eq("id", existing.id)
    .in("status", FROM[input.status])
    .select("id");

  if (updateError) throw updateError;
  if (!claimed || claimed.length === 0) return orderId;

  if (input.status === "paid") {
    await applyCapturedPayment(supabase, {
      orderId,
      paymentId: existing.id as string,
      capturedPaise: Number(existing.amount_paise ?? 0),
    });
    return orderId;
  }

  // authorized / failed / refunded: mirror onto the order, but never over a
  // paid one.
  const { error: orderError } = await supabase
    .from("orders")
    .update({ payment_status: input.status })
    .eq("id", orderId)
    .neq("payment_status", "paid");

  if (orderError) throw orderError;

  if (input.status === "failed") {
    deferNotify(() => notifyPaymentFailed(orderId));
  }

  return orderId;
}

/**
 * The money has landed. Decide what that means for the order it was meant for.
 * The caller has already claimed the payment row, so this runs once per payment.
 */
async function applyCapturedPayment(
  supabase: ReturnType<typeof createAdminClient>,
  p: { orderId: string; paymentId: string; capturedPaise: number }
): Promise<void> {
  const { data: order, error } = await supabase
    .from("orders")
    .select("total, status")
    .eq("id", p.orderId)
    .maybeSingle();
  if (error) throw error;

  // No order to apply it to (cascade-deleted mid-flight). The payment row is the
  // record; say so loudly rather than mark anything.
  if (!order) {
    recordDomain("payment.settle", "error", "Payment captured for a missing order", {
      orderId: p.orderId,
      attrs: { reason: "order_missing", paymentId: p.paymentId },
    });
    return;
  }

  const decision = decideSettlement({
    capturedPaise: p.capturedPaise,
    orderTotal: Number(order.total ?? 0),
    orderStatus: String(order.status ?? ""),
  });

  if (decision.kind === "hold_underpaid") {
    // The money is real, the order is not covered. Flag the payment row and the
    // alert; leave orders.payment_status alone so the kitchen never sees it.
    await supabase
      .from("payments")
      .update({
        error_code: "amount_mismatch",
        error_description: `Captured ${p.capturedPaise} paise; order needs ${totalToPaise(Number(order.total ?? 0))}.`,
      })
      .eq("id", p.paymentId);
    recordDomain("payment.settle", "error", "Captured payment is less than the order total", {
      orderId: p.orderId,
      attrs: {
        reason: "amount_mismatch",
        paymentId: p.paymentId,
        capturedPaise: p.capturedPaise,
        shortfallPaise: decision.shortfallPaise,
      },
    });
    return;
  }

  // Conditional, so that of two callers applying the same capture (the browser
  // callback, the webhook, a retry healing a failed first attempt) exactly one
  // gets a row back and goes on to notify; the other changes nothing.
  const { data: marked, error: orderError } = await supabase
    .from("orders")
    .update({ payment_status: "paid" })
    .eq("id", p.orderId)
    .neq("payment_status", "paid")
    .select("id");
  if (orderError) throw orderError;
  if (!marked || marked.length === 0) {
    recordDomain("payment.settle", "warn", "Payment captured for an order already marked paid", {
      orderId: p.orderId,
      attrs: { reason: "already_paid", paymentId: p.paymentId },
    });
    return;
  }

  if (decision.kind === "accept_cancelled") {
    const refund = await queueRefundForOrder(p.orderId, {
      origin: "system",
      reason: "Payment captured after the order was cancelled",
    });
    recordDomain("payment.settle", "warn", "Payment captured for a cancelled order", {
      orderId: p.orderId,
      attrs: { reason: "paid_after_cancel", refundQueued: refund.queued },
    });
    return;
  }

  if (decision.overpaidPaise > 0) {
    recordDomain("payment.settle", "warn", "Captured payment exceeds the order total", {
      orderId: p.orderId,
      attrs: { reason: "overpaid", overpaidPaise: decision.overpaidPaise },
    });
  }

  // The money landing is what makes an online order the kitchen's problem —
  // createOrder deliberately stayed quiet for it, so the alert belongs here.
  deferNotify(() => notifyVendorNewOrder(p.orderId));
}
