import "server-only";
import { createClient } from "@/lib/supabase/server";
import { customerInsights, type CustomerInsights } from "@/lib/vendor/insights";
import { orderFoodValue } from "@/lib/settlements/math";
import { SALE_STATUSES } from "@/lib/data-access/vendor-sales";
import { isReviewId, normalizeReplyText } from "@/lib/vendor/vendor-reviews";
import {
  summarizeRating,
  toVendorReviews,
  type ReplyRow,
  type ReviewRow,
  type VendorReview,
} from "@/lib/vendor/vendor-reviews";

export interface VendorReviewsData {
  average: number | null;
  count: number;
  reviews: VendorReview[];
  /** There are more published reviews than this page carries. */
  hasMore: boolean;
}

/** One page is enough for a single shop's launch; callers can raise it up to 100. */
const VENDOR_REVIEWS_PAGE = 50;

/**
 * Published reviews of one of the vendor's own shops, newest first, with the
 * vendor's replies.
 *
 * Reads through the signed-in user's own client, so row-level security is the
 * authority on what comes back ("reviews — vendor read own restaurant"): a
 * shop that is not theirs returns nothing, whatever id is asked for. The column
 * list is the granted one and has no `user_id`, so the reviewer is not
 * identified. Hidden and removed reviews are filtered out here as well, since
 * the vendor policy would otherwise let the author-side statuses through.
 */
export async function getVendorReviews(
  restaurantId: string,
  limit: number = VENDOR_REVIEWS_PAGE
): Promise<VendorReviewsData> {
  const supabase = await createClient();
  const pageSize = Math.min(Math.max(limit, 1), 100);

  const [reviewsRes, shopRes] = await Promise.all([
    supabase
      .from("reviews")
      .select(
        "id, order_id, rating, comment, created_at, edited_at, food_quality, packaging, delivery_experience, value_for_money"
      )
      .eq("restaurant_id", restaurantId)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(pageSize + 1)
      .overrideTypes<ReviewRow[]>(),
    supabase
      .from("restaurants")
      .select("rating, rating_count")
      .eq("id", restaurantId)
      .maybeSingle(),
  ]);

  if (reviewsRes.error) throw reviewsRes.error;
  if (shopRes.error) throw shopRes.error;

  const all = reviewsRes.data ?? [];
  const hasMore = all.length > pageSize;
  const rows = hasMore ? all.slice(0, pageSize) : all;

  let replies: ReplyRow[] = [];
  if (rows.length > 0) {
    const repliesRes = await supabase
      .from("review_replies")
      .select("review_id, reply_text, created_at, edited_at")
      .in(
        "review_id",
        rows.map((r) => r.id)
      )
      .overrideTypes<ReplyRow[]>();
    if (repliesRes.error) throw repliesRes.error;
    replies = repliesRes.data ?? [];
  }

  const shop = shopRes.data as {
    rating: number | null;
    rating_count: number | null;
  } | null;
  const { average, count } = summarizeRating(
    shop?.rating ?? null,
    shop?.rating_count ?? null
  );

  return { average, count, reviews: toVendorReviews(rows, replies), hasMore };
}

export type ReplyError = "invalid" | "empty" | "too_long" | "not_found" | "server_error";

/**
 * Write (or edit) the shop's public reply to one of its published reviews.
 * Runs as the signed-in vendor: the 0033 policies ("review replies — vendor
 * insert / edit") are the last word; this is the earlier, explainable check.
 * Shared by the web action and the Partner app route.
 */
export async function saveReviewReply(
  restaurantId: string,
  authorId: string,
  reviewId: string,
  text: string
): Promise<{ ok: true } | { ok: false; error: ReplyError }> {
  if (!isReviewId(reviewId)) return { ok: false, error: "invalid" };
  const reply = normalizeReplyText(text);
  if (!reply.ok) return { ok: false, error: reply.error };
  try {
    const supabase = await createClient();
    const { data: review, error: reviewError } = await supabase
      .from("reviews")
      .select("id")
      .eq("id", reviewId)
      .eq("restaurant_id", restaurantId)
      .eq("status", "published")
      .maybeSingle();
    if (reviewError) throw reviewError;
    if (!review) return { ok: false, error: "not_found" };

    const { data: existing, error: existingError } = await supabase
      .from("review_replies")
      .select("id")
      .eq("review_id", reviewId)
      .maybeSingle();
    if (existingError) throw existingError;

    const { error } = existing
      ? await supabase
          .from("review_replies")
          .update({ reply_text: reply.text, edited_at: new Date().toISOString() })
          .eq("id", existing.id)
      : await supabase.from("review_replies").insert({ review_id: reviewId, author_id: authorId, reply_text: reply.text });
    if (error) throw error;
    return { ok: true };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/**
 * Who orders, how often they come back and what they spend, over the last
 * [days] (requirements §10). Read with the vendor's own client (RLS: their
 * orders). Only the customer's name is read — never a phone number.
 */
export async function getCustomerInsights(restaurantId: string, days = 90): Promise<CustomerInsights> {
  const supabase = await createClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select("customer_id, created_at, total, delivery_fee, tax_amount, tip, discount, discount_funded_by, customer:profiles!orders_customer_id_fkey(full_name)")
    .eq("restaurant_id", restaurantId)
    .in("status", [...SALE_STATUSES])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw error;
  return customerInsights(
    (data ?? []).map((r) => {
      const c = Array.isArray(r.customer) ? r.customer[0] : r.customer;
      return {
        customerId: (r.customer_id as string | null) ?? null,
        customerName: (c as { full_name?: string | null } | null)?.full_name ?? null,
        createdAt: r.created_at as string,
        sale: orderFoodValue({
          total: Number(r.total) || 0,
          deliveryFee: Number(r.delivery_fee) || 0,
          taxAmount: Number(r.tax_amount) || 0,
          tip: Number(r.tip) || 0,
          discount: Number(r.discount) || 0,
          discountFundedBy: r.discount_funded_by === "platform" ? "platform" : "vendor",
        }),
      };
    })
  );
}
