/**
 * What a customer may send when rating the rider who delivered their order -
 * pure, so the route, the data layer and `scripts/qa/rider-rating.ts` share one
 * definition.
 *
 * The limits are the table's own (0084): `rating smallint check (1..5)` and
 * `comment text check (char_length(comment) <= 300)`. A comment is counted in
 * characters (code points), as Postgres counts it, not in UTF-16 units - so a
 * comment of 300 emoji is allowed and one of 301 is not.
 */

export const MAX_RATING_COMMENT = 300;

export type RatingInputError = "invalid_body" | "invalid_rating" | "comment_too_long";

/** The refusals a rating can meet after its input is valid. */
export type RiderRatingError =
  | RatingInputError
  | "not_yours"
  | "not_delivered"
  | "no_rider"
  | "already_rated";

export function parseRiderRating(
  input: { rating?: unknown; comment?: unknown } | null | undefined
):
  | { ok: true; rating: number; comment: string | null }
  | { ok: false; error: RatingInputError } {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid_body" };
  const { rating, comment } = input;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "invalid_rating" };
  }
  if (comment !== undefined && comment !== null && typeof comment !== "string") {
    return { ok: false, error: "invalid_body" };
  }
  const text = typeof comment === "string" ? comment.trim() : "";
  if ([...text].length > MAX_RATING_COMMENT) return { ok: false, error: "comment_too_long" };
  return { ok: true, rating, comment: text === "" ? null : text };
}

/** The HTTP status each refusal answers with. */
export function ratingErrorStatus(error: RiderRatingError | "migration_pending"): number {
  switch (error) {
    case "invalid_body":
    case "invalid_rating":
    case "comment_too_long":
      return 400;
    case "not_yours":
      return 403;
    case "not_delivered":
    case "no_rider":
    case "already_rated":
      return 409;
    case "migration_pending":
      return 503;
  }
}
