import "server-only";
import { createClient } from "@/lib/supabase/server";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyShop } from "@/lib/notifications/notify-user";

/** Ratings & reviews. Insert is RLS-gated to the customer's own delivered order. */

export async function submitReview(
  orderId: string,
  rating: number,
  comment?: string
): Promise<{ ok: boolean; error?: string }> {
  if (rating < 1 || rating > 5) return { ok: false, error: "invalid_rating" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  // Resolve the restaurant for this order (RLS lets the owner read their order).
  const { data: order } = await supabase
    .from("orders")
    .select("restaurant_id, status, customer_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return { ok: false, error: "not_found" };

  const { error } = await supabase.from("reviews").insert({
    order_id: orderId,
    user_id: user.id,
    restaurant_id: order.restaurant_id,
    rating,
    comment: comment?.slice(0, 500) || null,
  });
  if (error) {
    // Unique(order_id) → already reviewed.
    if (error.code === "23505") return { ok: false, error: "already_reviewed" };
    return { ok: false, error: "server_error" };
  }
  // The shop hears about it (Partner app inbox + push, requirements §10, §13).
  deferNotify(() =>
    notifyShop(order.restaurant_id as string, {
      category: "reviews",
      title: `New ${rating}★ review`,
      body: comment?.trim() ? `"${comment.trim().slice(0, 140)}"` : `A customer rated their order ${rating} out of 5.`,
      url: "/more/reviews",
      data: { orderId },
    })
  );
  return { ok: true };
}

