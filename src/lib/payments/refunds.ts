import "server-only";
import { isRazorpayConfigured, RazorpayError } from "@/lib/payments/razorpay";
import { razorpayFetch } from "@/lib/payments/razorpay-fetch";

/**
 * Razorpay — giving money back.
 *
 * Kept beside `razorpay.ts` rather than inside it because the two directions are
 * not the same risk. Taking money that never arrives is a bug the customer
 * reports; returning money twice is a loss nobody reports, and the only thing
 * standing between the two is being precise about what the gateway actually
 * confirmed. So this module refuses to round anything up: it reports a refund as
 * settled only when Razorpay says `processed`, and it throws rather than return
 * a half-answer.
 *
 * Same shape as `razorpay.ts`: server-only, no SDK, fails closed when
 * unconfigured, and every failure is a `RazorpayError` carrying the status the
 * caller should surface.
 *
 * `isRazorpayConfigured` is imported, not recomputed — there must be exactly one
 * answer to "can we talk to Razorpay at all", or the refund path could believe
 * the gateway is reachable while checkout is showing "Available soon". The key
 * pair itself is read again here only because `razorpay.ts` keeps `authHeader()`
 * private and exports no way to reach it; widening that module's surface is not
 * this change's to make. Same variables, same precedence, same fallback.
 */

const KEY_ID =
  process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "";

const API = "https://api.razorpay.com/v1";

function authHeader(): string {
  const credentials = `${KEY_ID}:${KEY_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/**
 * Razorpay's refund entity. `status` is the field that matters:
 *
 *   processed — the money has left us and is on its way to the customer,
 *   pending   — the gateway accepted the instruction but hasn't settled it yet,
 *   failed    — nothing moved.
 *
 * `pending` still means committed: the refund id exists and asking again would
 * return the money twice. It is not, however, "refunded" — see `settled` below.
 */
export interface RazorpayRefund {
  id: string;
  amount: number;
  currency: string;
  status: string;
  payment_id?: string;
  /**
   * Our own reading of `status`: true only when Razorpay has actually processed
   * it. The caller writes `settled_at` from this and nothing else, so the admin
   * queue never claims a customer has their money back before they do.
   */
  settled: boolean;
}

/**
 * Refund a captured Razorpay payment.
 *
 * `amountPaise` is the smallest currency unit, derived by the caller from the
 * refund row the database holds — never from anything a browser sent.
 *
 * Throws on every unhappy path, deliberately. A caller that gets a value back
 * from this may record a refund; a caller that gets an exception must leave the
 * request pending, because "we don't know" and "the money went back" have to
 * stay distinguishable. Note there is no idempotency key on this call: Razorpay
 * does not offer one for refunds, so a retry after a network failure can create
 * a second refund. That is why a failure here is surfaced to a human instead of
 * being retried automatically.
 */
export async function refundRazorpayPayment(input: {
  providerPaymentId: string;
  amountPaise: number;
  notes?: Record<string, string>;
}): Promise<RazorpayRefund> {
  if (!isRazorpayConfigured) {
    throw new RazorpayError("razorpay_not_configured", 503);
  }
  if (!input.providerPaymentId) {
    throw new RazorpayError("invalid_payment_id", 400);
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new RazorpayError("invalid_amount", 400);
  }

  const res = await razorpayFetch(
    "payments.refund",
    `${API}/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        notes: input.notes,
        // Explicit rather than defaulted. 'optimum' buys an instant refund at a
        // per-refund fee; 'normal' is the settlement everyone here expects, and
        // silently paying for the faster one is not a decision this code gets
        // to make.
        speed: "normal",
      }),
      cache: "no-store",
    }
  );

  if (!res.ok) {
    // Razorpay's body carries the reason, but it is not ours to forward
    // verbatim — log-shaped message, generic status upstream. Matches
    // createRazorpayOrder.
    throw new RazorpayError(`razorpay_refund_failed_${res.status}`, 502);
  }

  const refund = (await res.json()) as Omit<RazorpayRefund, "settled">;
  if (!refund?.id) throw new RazorpayError("razorpay_refund_malformed", 502);

  // A 200 with status 'failed' is Razorpay telling us the refund did not
  // happen. Treating that as success is exactly the "money returned that
  // wasn't" bug, so it throws like any other failure.
  if (refund.status === "failed") {
    throw new RazorpayError("razorpay_refund_rejected", 502);
  }

  return { ...refund, settled: refund.status === "processed" };
}
