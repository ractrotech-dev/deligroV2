import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { parseRiderRating, type RiderRatingError } from "@/lib/rider/rating";

/**
 * A customer rates the rider who delivered their order (0084 `rider_ratings`).
 *
 * `customerId` comes from the caller's session (`POST /api/orders/:id/rider-rating`
 * behind `auth.getUser()`), never from a request body: it is both who is
 * rating and the only person whose order may be rated. This runs on the
 * service-role client because a customer cannot read `deliveries` under RLS, so
 * the table's own insert policy (which looks the delivery up as the customer)
 * refuses even a valid rating; every condition that policy states is checked
 * here instead, BEFORE the insert, and the table's constraints (one rating per
 * order, 1-5, 300 characters) are the last word:
 *
 *   not_yours      the order is not this customer's (or does not exist)
 *   not_delivered  the order, or its delivery, is not delivered yet
 *   no_rider       delivered, but no rider is recorded on it (nobody to rate)
 *   already_rated  the order already has a rating (UNIQUE order_id, 23505)
 *
 * The rider rated is read from the delivery, never from the client. Before 0084
 * it throws `RiderSchemaPendingError` (the route answers 503 `migration_pending`).
 */
export async function submitRiderRating(
  customerId: string,
  orderId: string,
  input: { rating?: unknown; comment?: unknown } | null
): Promise<{ ok: true; rating: number; comment: string | null } | { ok: false; error: RiderRatingError }> {
  const parsed = parseRiderRating(input);
  if (!parsed.ok) return parsed;

  const admin = createAdminClient();
  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, customer_id, status")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; customer_id: string | null; status: string }>();
  if (orderError) throw orderError;
  // Someone else's order and no such order answer the same.
  if (!order || !order.customer_id || order.customer_id !== customerId) return { ok: false, error: "not_yours" };
  if (order.status !== "delivered") return { ok: false, error: "not_delivered" };

  const { data: delivery, error: deliveryError } = await admin
    .from("deliveries")
    .select("driver_id, status")
    .eq("order_id", orderId)
    .maybeSingle()
    .overrideTypes<{ driver_id: string | null; status: string }>();
  if (deliveryError) throw deliveryError;
  if (!delivery?.driver_id) return { ok: false, error: "no_rider" };
  // The order can be marked delivered by staff while the rider on it never
  // finished: that rider has not earned a rating.
  if (delivery.status !== "delivered") return { ok: false, error: "not_delivered" };

  const { error } = await admin.from("rider_ratings").insert({
    order_id: orderId,
    driver_id: delivery.driver_id,
    customer_id: customerId,
    rating: parsed.rating,
    comment: parsed.comment,
  });
  if (error) {
    if (error.code === "23505") return { ok: false, error: "already_rated" };
    if (isMissingTable(error)) {
      throw new RiderSchemaPendingError("migration_pending: rider_ratings (0084) is not applied");
    }
    throw error;
  }
  return { ok: true, rating: parsed.rating, comment: parsed.comment };
}

/**
 * The rating this customer gave for this order, or nulls. Filtered by BOTH the
 * order and the customer, so another customer's rating is never returned (and
 * an order that is not theirs answers exactly like one with no rating).
 */
export async function getOwnRiderRating(
  customerId: string,
  orderId: string
): Promise<{ rating: number | null; comment: string | null }> {
  const { data, error } = await createAdminClient()
    .from("rider_ratings")
    .select("rating, comment")
    .eq("order_id", orderId)
    .eq("customer_id", customerId)
    .maybeSingle()
    .overrideTypes<{ rating: number | string; comment: string | null }>();
  if (error) {
    // Before 0084 nobody has rated anyone.
    if (isMissingTable(error)) return { rating: null, comment: null };
    throw error;
  }
  return data ? { rating: Number(data.rating), comment: data.comment } : { rating: null, comment: null };
}
