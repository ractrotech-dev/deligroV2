/**
 * What a customer is told when the rider reports the shop is running late
 * (controller ruling P7-R1).
 *
 * A rider's pickup report of kind `vendor_delay` (Phase 2's exception sheet)
 * reaches the customer as ONE fixed sentence — never the rider's free text,
 * which is written for ops and can name people or blame them. Shown on the
 * web tracking view and the customer app's tracking screen while the food is
 * still at the shop: not once the rider has picked it up, and not on a
 * finished order.
 *
 * Pure and import-free: the tracking snapshot, the view and the QA script use
 * the same rule and the same words (the Flutter app carries the same string).
 */

export const SHOP_RUNNING_LATE = "The shop is running late";

export function showShopDelay(input: {
  /** `orders.status` (database value). */
  orderStatus: string;
  /** `deliveries.status`, null before a delivery row exists. */
  deliveryStatus: string | null;
  /** A `vendor_delay` report exists for this order. */
  vendorDelayReported: boolean;
}): boolean {
  if (!input.vendorDelayReported) return false;
  if (["on_the_way", "delivered", "cancelled"].includes(input.orderStatus)) return false;
  return !["picked_up", "delivered", "failed", "cancelled"].includes(input.deliveryStatus ?? "");
}
