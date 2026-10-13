"use server";

import { revalidatePath } from "next/cache";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { rateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { isReviewId, normalizeReplyText } from "@/lib/vendor/vendor-reviews";

export type ReplyResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "forbidden"
        | "invalid"
        | "empty"
        | "too_long"
        | "rate_limited"
        | "not_found"
        | "server_error";
    };

/**
 * Write (or edit) the shop's public reply to one review.
 *
 * Runs as the signed-in vendor, never as the service role: the database's own
 * policies ("review replies — vendor insert / edit") are the last word on who
 * may reply to what, and this action is a second, earlier check. A shop owner
 * may only answer a published review of the shop they are working in; one reply
 * per review (`review_id` is unique), edited in place.
 */
export async function saveReviewReplyAction(
  reviewId: string,
  text: string
): Promise<ReplyResult> {
  const profile = await getProfile();
  if (!profile || !(await hasVendorAccess(profile))) {
    return { ok: false, error: "forbidden" };
  }
  if (!isReviewId(reviewId)) return { ok: false, error: "invalid" };

  const reply = normalizeReplyText(text);
  if (!reply.ok) return { ok: false, error: reply.error };

  // Bound how fast one account can post. Replies are public text.
  const limit = await rateLimit(`review-reply:${profile.id}`, 20, 60_000);
  if (!limit.ok) return { ok: false, error: "rate_limited" };

  try {
    const restaurant = await resolveVendorRestaurant();
    if (!restaurant) return { ok: false, error: "forbidden" };

    const supabase = await createClient();

    // The review has to belong to the shop being worked in, and be published.
    const { data: review, error: reviewError } = await supabase
      .from("reviews")
      .select("id")
      .eq("id", reviewId)
      .eq("restaurant_id", restaurant.id)
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

    if (existing) {
      const { error } = await supabase
        .from("review_replies")
        .update({ reply_text: reply.text, edited_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("review_replies").insert({
        review_id: reviewId,
        author_id: profile.id,
        reply_text: reply.text,
      });
      if (error) throw error;
    }
  } catch {
    return { ok: false, error: "server_error" };
  }

  revalidatePath("/vendor/reviews");
  return { ok: true };
}
