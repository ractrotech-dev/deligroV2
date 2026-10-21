"use server";

import { revalidatePath } from "next/cache";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { rateLimit } from "@/lib/rate-limit";
import { saveReviewReply } from "@/lib/data-access/vendor-reviews";

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
  // Bound how fast one account can post. Replies are public text.
  const limit = await rateLimit(`review-reply:${profile.id}`, 20, 60_000);
  if (!limit.ok) return { ok: false, error: "rate_limited" };

  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) return { ok: false, error: "forbidden" };

  const saved = await saveReviewReply(restaurant.id, profile.id, reviewId, text);
  if (!saved.ok) return saved;

  revalidatePath("/vendor/reviews");
  return { ok: true };
}
