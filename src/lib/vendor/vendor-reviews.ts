/**
 * The vendor Reviews screen: the parts that need no database, so they can be
 * tested on their own.
 *
 * What a vendor may see of a review is deliberately narrow. The database grants
 * no `user_id` column to anyone but the service role (0024 L-2, 0033), so the
 * reviewer is never identified here; the vendor gets the rating, the sub-ratings,
 * the comment, the date, the order code they already know from their own
 * orders, and their own reply.
 */

export const REPLY_MAX = 1000;

export type ReplyCheck =
  | { ok: true; text: string }
  | { ok: false; error: "invalid" | "empty" | "too_long" };

/** A reply as the database will accept it: 1 to 1000 characters after trimming. */
export function normalizeReplyText(raw: unknown): ReplyCheck {
  if (typeof raw !== "string") return { ok: false, error: "invalid" };
  const text = raw.split("\r\n").join("\n").trim();
  if (text.length === 0) return { ok: false, error: "empty" };
  if (text.length > REPLY_MAX) return { ok: false, error: "too_long" };
  return { ok: true, text };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReviewId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The same short code the order screens use: the first eight characters, upper-cased. */
export function orderCode(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

export interface ReviewRow {
  id: string;
  order_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  edited_at: string | null;
  food_quality: number | null;
  packaging: number | null;
  delivery_experience: number | null;
  value_for_money: number | null;
}

export interface ReplyRow {
  review_id: string;
  reply_text: string;
  created_at: string;
  edited_at: string | null;
}

export interface VendorReview {
  id: string;
  orderCode: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  edited: boolean;
  /** Only the sub-ratings the customer actually gave. */
  details: { label: string; value: number }[];
  reply: { text: string; createdAt: string; edited: boolean } | null;
}

const DETAIL_LABELS: [keyof ReviewRow, string][] = [
  ["food_quality", "Food"],
  ["packaging", "Packaging"],
  ["delivery_experience", "Delivery"],
  ["value_for_money", "Value"],
];

export function toVendorReviews(
  rows: ReviewRow[],
  replies: ReplyRow[]
): VendorReview[] {
  const replyByReview = new Map(replies.map((r) => [r.review_id, r]));
  return rows.map((row) => {
    const reply = replyByReview.get(row.id);
    const comment = row.comment?.trim();
    return {
      id: row.id,
      orderCode: orderCode(row.order_id),
      rating: row.rating,
      comment: comment ? comment : null,
      createdAt: row.created_at,
      edited: row.edited_at !== null,
      details: DETAIL_LABELS.flatMap(([key, label]) => {
        const value = row[key];
        return typeof value === "number" ? [{ label, value }] : [];
      }),
      reply: reply
        ? {
            text: reply.reply_text,
            createdAt: reply.created_at,
            edited: reply.edited_at !== null,
          }
        : null,
    };
  });
}

/**
 * The shop's average for the header. `rating_count = 0` is the database's
 * "unrated" signal (a shop's rating column then holds a placeholder, not a
 * score), so it reads as no average at all, never as 0 or 5.
 */
export function summarizeRating(
  rating: number | null,
  count: number | null
): { average: number | null; count: number } {
  const n = typeof count === "number" && count > 0 ? count : 0;
  if (n === 0 || typeof rating !== "number" || !Number.isFinite(rating)) {
    return { average: null, count: n };
  }
  return { average: Math.round(rating * 10) / 10, count: n };
}
