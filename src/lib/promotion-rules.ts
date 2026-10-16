/**
 * Rules a promo code has to satisfy, and the badge text one produces.
 *
 * Shared by the admin console and the vendor's own promotions screen so both
 * refuse the same things for the same reasons. This is the *convenience* half
 * of validation — the database holds the real floor (CHECK constraints on
 * `funded_by`/scope, and the RLS policies that decide who may write a row at
 * all), and every rule here that matters is one of those too. A form that
 * validates and a database that doesn't is the arrangement AGENTS.md §3 warns
 * about; this is the other way round on purpose.
 */

export type PromotionKind = "percent" | "flat";
export type PromotionFunding = "platform" | "vendor";

export interface PromotionDraft {
  code: string;
  label: string | null;
  kind: PromotionKind;
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  active: boolean;
  expiresAt: string | null;
  maxPerCustomer: number | null;
  maxRedemptions: number | null;
  restaurantId: string | null;
  fundedBy: PromotionFunding;
}

/**
 * Uppercase letters and digits only, 4–24 characters.
 *
 * Not a style preference: the checkout uppercases what the customer types and
 * the RPC matches on that, so a lowercase or spaced code would be a code
 * nobody could enter. Punctuation is excluded for the same reason — a hyphen
 * that half the customers omit is a support ticket.
 */
const PROMO_CODE_PATTERN = /^[A-Z0-9]{4,24}$/;

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/** The first problem with the discount itself — its size, floor and cap. */
function discountProblem(d: PromotionDraft): string | null {
  if (!Number.isFinite(d.value) || d.value <= 0) {
    return "The discount has to be more than zero.";
  }
  if (d.kind === "percent" && d.value > 100) {
    return "A percentage discount can't be more than 100%.";
  }
  if (d.minOrder < 0) return "The minimum order can't be negative.";
  if (d.maxDiscount != null && d.maxDiscount <= 0) {
    return "The cap has to be more than zero, or left blank for no cap.";
  }
  if (d.kind === "flat" && d.maxDiscount != null) {
    return "A flat-rupees code is already its own cap — leave that blank.";
  }
  return null;
}

/** The first problem with how often, and until when, the code may be used. */
function usageProblem(d: PromotionDraft): string | null {
  if (d.maxPerCustomer != null && d.maxPerCustomer < 1) {
    return "Per-customer uses must be at least 1, or blank for unlimited.";
  }
  if (d.maxRedemptions != null && d.maxRedemptions < 1) {
    return "Total redemptions must be at least 1, or blank for unlimited.";
  }
  if (d.expiresAt && Number.isNaN(Date.parse(d.expiresAt))) {
    return "That end date isn't a date.";
  }
  return null;
}

/** The first problem with this draft, or null. */
export function validatePromotion(d: PromotionDraft): string | null {
  if (!PROMO_CODE_PATTERN.test(d.code)) {
    return "A code is 4–24 characters, letters and numbers only.";
  }
  const problem = discountProblem(d) ?? usageProblem(d);
  if (problem) return problem;
  // Mirrors coupons_funding_scope_check: "the vendor pays" needs a vendor.
  if (d.fundedBy === "vendor" && !d.restaurantId) {
    return "A vendor-funded code has to belong to a shop.";
  }
  // An uncapped percentage code is how a promotion becomes an unbounded
  // liability on a large order. Not fatal — an operator may mean it — but a
  // vendor typing "50%" rarely means "50% of a ₹4,000 party order".
  if (d.kind === "percent" && d.value >= 50 && d.maxDiscount == null) {
    return "A discount of 50% or more needs a cap in rupees.";
  }
  return null;
}

/**
 * Mirrors `promo_amount_text()` in migration 0041: two decimals at most, and no
 * trailing zeros or stranded decimal point, so 35 reads "35" and not "35.00"
 * or "35.".
 */
function money(n: number): string {
  return n.toFixed(2).replace(/(?<!0)0+$/, "").replace(/\.$/, "");
}

/**
 * The badge customers see for a shop running this code.
 *
 * A preview, not the source. The stored string is written by
 * `refresh_restaurant_offer()` in migration 0041 — this exists so the form can
 * show what the shop's card is about to say, and it deliberately mirrors that
 * function's formatting. If they ever disagree, the database is right and this
 * is the bug.
 */
export function offerBadgeText(d: {
  kind: PromotionKind;
  value: number;
  maxDiscount: number | null;
  minOrder: number;
}): string {
  let head: string;
  if (d.kind === "percent") {
    const cap = d.maxDiscount != null ? ` up to ₹${money(d.maxDiscount)}` : "";
    head = `${money(d.value)}% OFF${cap}`;
  } else {
    head = `₹${money(d.value)} OFF`;
  }
  return d.minOrder > 0 ? `${head} over ₹${money(d.minOrder)}` : head;
}
