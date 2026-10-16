/**
 * QA — the vendor Reviews screen.
 *
 * Pins, offline:
 *   - reply text is accepted only as the database will take it (1 to 1000
 *     characters after trimming);
 *   - the view model shows only what the customer gave, and never a "0" or "5"
 *     for an unrated shop;
 *   - the screen cannot identify the reviewer;
 *   - the reply action runs as the signed-in vendor (never the service role),
 *     only for a published review of the shop being worked in, and is limited;
 *   - the vendor cannot hide, report or delete a review from here;
 *   - the screen is in the vendor nav but not in the phone's five-slot bar;
 *   - no Hindi was added.
 *
 * Usage: npm run test:vendor-reviews
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPLY_MAX,
  isReviewId,
  normalizeReplyText,
  orderCode,
  summarizeRating,
  toVendorReviews,
  type ReplyRow,
  type ReviewRow,
} from "../../src/lib/vendor/vendor-reviews";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log("\n═══ reply text ═══");
check("a normal reply is accepted and trimmed", JSON.stringify(normalizeReplyText("  Thank you!  ")), JSON.stringify({ ok: true, text: "Thank you!" }));
check("an empty reply is refused", JSON.stringify(normalizeReplyText("")), JSON.stringify({ ok: false, error: "empty" }));
check("whitespace only is refused", JSON.stringify(normalizeReplyText("   ")), JSON.stringify({ ok: false, error: "empty" }));
check("exactly the maximum is accepted", normalizeReplyText("a".repeat(REPLY_MAX)).ok, true);
check("one over the maximum is refused", JSON.stringify(normalizeReplyText("a".repeat(REPLY_MAX + 1))), JSON.stringify({ ok: false, error: "too_long" }));
check("padding does not count towards the maximum", normalizeReplyText(" ".repeat(50) + "a".repeat(REPLY_MAX) + " ".repeat(50)).ok, true);
check("a non-string is refused", JSON.stringify(normalizeReplyText(42)), JSON.stringify({ ok: false, error: "invalid" }));
check("undefined is refused", JSON.stringify(normalizeReplyText(undefined)), JSON.stringify({ ok: false, error: "invalid" }));
check("Windows line breaks are normalised", (normalizeReplyText("a" + String.fromCodePoint(13, 10) + "b") as { text: string }).text, "a\nb");

console.log("\n═══ review ids ═══");
check("a uuid is a review id", isReviewId("3f2b1c4e-9a7d-4e21-8b6a-0c5d7e9f1a23"), true);
check("anything else is not", isReviewId("1; drop table reviews"), false);
check("a number is not", isReviewId(7), false);

console.log("\n═══ the view model ═══");
const base: ReviewRow = {
  id: "r1",
  order_id: "abcdef12-3456-4789-8abc-def012345678",
  rating: 4,
  comment: "  Tasty, a bit late.  ",
  created_at: "2026-10-10T12:00:00Z",
  edited_at: null,
  food_quality: 5,
  packaging: null,
  delivery_experience: 3,
  value_for_money: null,
};
const replies: ReplyRow[] = [{ review_id: "r1", reply_text: "Thanks!", created_at: "2026-10-11T08:00:00Z", edited_at: "2026-10-11T09:00:00Z" }];
const [withReply] = toVendorReviews([base], replies);
check("the order code is the short code vendors already know", withReply.orderCode, "ABCDEF12");
check("orderCode matches the shared helper's shape", orderCode("abcdef12-3456"), "ABCDEF12");
check("the comment is trimmed", withReply.comment, "Tasty, a bit late.");
check("only the sub-ratings the customer gave are listed", withReply.details.map((d) => d.label).join(","), "Food,Delivery");
check("their values are kept", withReply.details.map((d) => d.value).join(","), "5,3");
check("the reply is attached", withReply.reply?.text, "Thanks!");
check("an edited reply says so", withReply.reply?.edited, true);
const [bare] = toVendorReviews([{ ...base, id: "r2", comment: "   ", food_quality: null, delivery_experience: null, edited_at: "2026-10-10T13:00:00Z" }], []);
check("a blank comment becomes none", bare.comment, null);
check("no sub-ratings means none listed", bare.details.length, 0);
check("a review without a reply has none", bare.reply, null);
check("an edited review says so", bare.edited, true);
check("the view model carries no reviewer field", Object.keys(withReply).some((k) => /user|customer|name|phone/i.test(k)), false);

console.log("\n═══ the shop's average ═══");
check("no ratings is no average, not 0", summarizeRating(5, 0).average, null);
check("a null count is no ratings", summarizeRating(4.2, null).count, 0);
check("a placeholder 5.0 with no ratings is not shown as 5", summarizeRating(5, 0).average, null);
check("an average rounds to one decimal", summarizeRating(4.5333, 100).average, 4.5);
check("and keeps the count", summarizeRating(4.5333, 100).count, 100);
check("a non-finite rating is no average", summarizeRating(Number.NaN, 10).average, null);

console.log("\n═══ privacy and authorization (structural) ═══");
const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8").split("\r\n").join("\n");
const data = read("src/lib/data-access/vendor-reviews.ts");
const action = read("src/app/vendor/reviews/actions.ts");
const page = read("src/app/vendor/reviews/page.tsx");
const board = read("src/components/vendor/vendor-reviews-board.tsx");
const nav = read("src/components/vendor/vendor-nav.ts");

const selects = [...data.matchAll(/\.select\(\s*"([^"]+)"/g)].map((m) => m[1]).join(" | ");
check("no query selects the reviewer's id", /user_id|customer_id/.test(selects), false);
check("only published reviews are read", data.includes('.eq("status", "published")'), true);
check("reads are scoped to the shop asked for", data.includes('.eq("restaurant_id", restaurantId)'), true);
check("reads use the signed-in user's client, not the service role", /createAdminClient|service_role|SUPABASE_SECRET/.test(data), false);
check("the page needs vendor access", page.includes("hasVendorAccess(profile)"), true);
check("and works only on the shop being worked in", page.includes("resolveVendorRestaurant()"), true);

check("the action checks vendor access", action.includes("hasVendorAccess(profile)"), true);
check("the action runs as the vendor, never the service role", /createAdminClient|service_role|SUPABASE_SECRET/.test(action), false);
check("the action validates the review id", action.includes("isReviewId(reviewId)"), true);
check("the action validates the text", action.includes("normalizeReplyText(text)"), true);
check("the action is rate limited", action.includes("rateLimit(`review-reply:"), true);
check("the review must belong to the active shop", action.includes('.eq("restaurant_id", restaurant.id)'), true);
check("and be published", action.includes('.eq("status", "published")'), true);
check("replies are written under the vendor's own id", action.includes("author_id: profile.id"), true);
check("the action never deletes", /\.delete\(/.test(action), false);
check("the vendor cannot change review status from here", /from\("reviews"\)\s*\.(update|insert|delete)/.test(action), false);
check("the vendor cannot raise a report from here", action.includes("review_flags"), false);
check("the screen refreshes the router cache after a reply", board.includes("router.refresh()"), true);
check("customer text is rendered as text, never as markup", board.includes("dangerouslySetInnerHTML"), false);

const reviewsNav = nav.slice(nav.indexOf('href: "/vendor/reviews"'), nav.indexOf('href: "/vendor/profile"'));
check("Reviews is in the vendor nav", reviewsNav.includes('label: "Reviews"'), true);
check("but not in the phone's five-slot bar", reviewsNav.includes("primary: true"), false);

console.log("\n═══ no Hindi added ═══");
// Built from code points so this file itself holds no Devanagari.
const DEVANAGARI = new RegExp("[" + String.fromCodePoint(0x0900) + "-" + String.fromCodePoint(0x097f) + "]");
let devanagari = 0;
for (const f of [
  "src/lib/vendor/vendor-reviews.ts",
  "src/lib/data-access/vendor-reviews.ts",
  "src/app/vendor/reviews/actions.ts",
  "src/app/vendor/reviews/page.tsx",
  "src/components/vendor/vendor-reviews-board.tsx",
  "scripts/qa/vendor-reviews.ts",
]) {
  if (DEVANAGARI.test(read(f))) devanagari++;
}
check("none of the new files contains Devanagari", devanagari, 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
