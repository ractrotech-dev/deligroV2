/**
 * What to do with a captured payment, decided from three facts only: how much
 * Razorpay says it took, what the order costs now, and where the order is.
 *
 * Pure on purpose (no server-only import): the rule moves money, so it is
 * checked by scripts/qa/settle-decision.ts rather than trusted.
 *
 * The payment row records the amount at the moment the Razorpay order was
 * created. The order total can move after that — items added before the kitchen
 * accepts — so "the customer paid" and "the customer paid enough" are separate
 * questions.
 */

export type SettleDecision =
  /** Paid in full (or over). Mark the order paid and ring the kitchen. */
  | { kind: "accept"; overpaidPaise: number }
  /** Money arrived for an order that is already cancelled. Mark paid, queue a refund, stay silent. */
  | { kind: "accept_cancelled" }
  /** Less than the order costs. Keep the order unpaid, keep the kitchen quiet, raise an alert. */
  | { kind: "hold_underpaid"; shortfallPaise: number };

/** Order total in rupees → paise, immune to 0.1 + 0.2 style float drift. */
export function totalToPaise(total: number): number {
  return Math.round(total * 100);
}

export function decideSettlement(input: {
  capturedPaise: number;
  orderTotal: number;
  orderStatus: string;
}): SettleDecision {
  const expected = totalToPaise(input.orderTotal);
  const shortfall = expected - input.capturedPaise;

  // Underpayment wins over every other case, including a cancelled order:
  // marking an order paid would let the refund queue return money that was
  // never taken.
  if (shortfall > 0) return { kind: "hold_underpaid", shortfallPaise: shortfall };

  if (input.orderStatus === "cancelled") return { kind: "accept_cancelled" };

  return { kind: "accept", overpaidPaise: -shortfall };
}

/**
 * Should a repeat "paid" for an already-paid payment row be applied to its order?
 *
 * The row is marked paid before the order is touched, so a failed order write
 * leaves a captured payment whose order still says pending. Razorpay retries the
 * webhook until we answer 2xx, and this is what lets that retry finish the job.
 * It must say no when the order is already paid (nothing to do, and no second
 * kitchen alert), and when the payment is held as underpaid — that row is 'paid'
 * on purpose and was already decided.
 */
export function shouldReapplyCapture(input: {
  paymentRowStatus: string;
  incomingStatus: string;
  paymentErrorCode: string | null | undefined;
  orderPaymentStatus: string | null | undefined;
}): boolean {
  if (input.paymentRowStatus !== "paid" || input.incomingStatus !== "paid") return false;
  if (input.paymentErrorCode === "amount_mismatch") return false;
  return input.orderPaymentStatus != null && input.orderPaymentStatus !== "paid";
}
