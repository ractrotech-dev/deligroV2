/**
 * The Partner app's six order statuses (client requirements §3, §16.4), from
 * the database's `order_status` plus `orders.preparing_at` (0061).
 *
 *   New / Pending     placed
 *   Accepted          kitchen, preparing_at null
 *   Preparing         kitchen, preparing_at set
 *   Ready for Pickup  ready
 *   Completed         on_the_way | delivered — the kitchen's part is done
 *   Cancelled         cancelled
 *
 * One definition, used by the board, the dashboard and the reports, so the
 * counts on every screen agree. Pure: no I/O, exercised by
 * scripts/qa/kitchen-stage.ts. The app mirrors it in lib/models/order.dart.
 */
export type KitchenStage = "new" | "accepted" | "preparing" | "ready" | "completed" | "cancelled";

export function kitchenStage(order: {
  status: string;
  preparingAt?: string | null;
}): KitchenStage | null {
  switch (order.status) {
    case "placed":
      return "new";
    case "kitchen":
      return order.preparingAt ? "preparing" : "accepted";
    case "ready":
      return "ready";
    case "on_the_way":
    case "delivered":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** The prep time a kitchen may promise on accept: a whole number of minutes, 1–180 (0061). */
export function parsePrepMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 180
    ? value
    : null;
}
