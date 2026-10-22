import { RazorpayError } from "@/lib/payments/razorpay";

/**
 * Did a failed gateway refund call certainly move no money?
 *
 *   definite — the gateway (or our own pre-checks) refused before money could
 *              move: not configured, a bad payment id or amount, or a 4xx from
 *              Razorpay. The refund's claim can be given back and the
 *              decision tried again.
 *   unknown  — a network failure or a 5xx: Razorpay may have refunded and we
 *              never heard. The claim stays, so nobody refunds again until an
 *              admin has looked at the Razorpay dashboard and released it.
 *
 * Razorpay has no idempotency key on refunds, so "unknown" must never be
 * treated as "nothing happened".
 */
export function classifyGatewayFailure(err: unknown): "definite" | "unknown" {
  if (!(err instanceof RazorpayError)) return "unknown";
  if (err.message === "razorpay_not_configured" || err.message.startsWith("invalid_")) return "definite";
  const status = /_(\d{3})$/.exec(err.message)?.[1];
  if (status && status.startsWith("4")) return "definite";
  return "unknown";
}
