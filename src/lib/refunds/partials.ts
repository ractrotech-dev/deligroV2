/**
 * Refund arithmetic once an order can carry more than one refund — an
 * unavailable item refunded while the order is still live, then the rest of the
 * total when it is cancelled. Pure (no `server-only`): scripts/qa/refund-partials.ts
 * runs it under tsx.
 *
 * The database holds the same rule (guard_refund_total, migration 0142):
 * approved refunds never exceed the order total. This copy runs BEFORE the
 * gateway is asked to move money, so a refund the database would refuse is
 * never paid out first.
 */

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Would approving `amount` on top of the already-approved refunds pay back more than the order total? */
export function approvalExceedsTotal(o: { total: number; approved: number[]; amount: number }): boolean {
  return sum(o.approved) + o.amount > o.total;
}

/** Paise the gateway can still return on a capture, after the refunds it already processed. */
export function gatewayRoomPaise(capturedPaise: number, refundedPaise: number[]): number {
  return Math.max(0, capturedPaise - sum(refundedPaise));
}

/** The order's payment reads `refunded` only once its refunds cover the whole total. */
export function isFullyRefunded(o: { total: number; approved: number[] }): boolean {
  return o.total > 0 && sum(o.approved) >= o.total;
}
