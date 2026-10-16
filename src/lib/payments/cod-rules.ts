/**
 * Which payment methods a shop takes, and the cash ceiling above which online
 * is the only option.
 *
 * Pure and client-safe on purpose: the checkout screen and the order API decide
 * from the SAME function, so the message a customer reads and the rule the
 * server enforces cannot drift apart. The server still re-resolves the rules
 * from the database on every order — this module decides, it does not trust.
 *
 * The wording is deliberately plain. "Orders above ₹300 must be paid online" is
 * a sentence a customer can act on; "COD_LIMIT_EXCEEDED" is not.
 */

export type CheckoutPaymentMethod = "cod" | "online";

export interface VendorPaymentRules {
  /** This shop takes cash on delivery. */
  acceptCod: boolean;
  /**
   * This shop takes online payment AND the platform can actually process it
   * (admin switch + Razorpay keys). Already ANDed by the server — a vendor
   * cannot enable a payment the platform cannot take.
   */
  acceptOnline: boolean;
  /** Highest total payable in cash, whole rupees. 0 = no ceiling. */
  codMaxOrder: number;
}

/** Both methods on, no ceiling — how an unconfigured shop behaves. */
export const DEFAULT_PAYMENT_RULES: VendorPaymentRules = {
  acceptCod: true,
  acceptOnline: true,
  codMaxOrder: 0,
};

type CodRefusal = "cod_off" | "over_limit";

export interface PaymentAvailability {
  cod: boolean;
  online: boolean;
  /** Why cash is not on offer, or null when it is. */
  codRefusal: CodRefusal | null;
  /** Plain-English line to show under the payment options, or null. */
  notice: string | null;
  /** True when the shop can take no payment at all — checkout must block. */
  noMethod: boolean;
}

function rupees(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

/**
 * What this basket may be paid with.
 *
 * `orderTotal` is the amount the customer will actually be charged — after any
 * coupon, including delivery and tax. That is the figure the rider collects, so
 * it is the figure a cash ceiling has to be measured against. Comparing the
 * item subtotal instead would let a ₹280 basket become ₹340 of cash at the door.
 */
export function paymentAvailability(
  rules: VendorPaymentRules,
  orderTotal: number
): PaymentAvailability {
  const limit = Math.max(0, Math.round(rules.codMaxOrder));
  const total = Math.max(0, Math.round(orderTotal));

  // `>` not `>=`: a limit of ₹300 means ₹300 itself is still payable in cash.
  // "Orders above ₹300" is what the customer is told, so it is what runs.
  const overLimit = limit > 0 && total > limit;

  const cod = rules.acceptCod && !overLimit;
  const codRefusal: CodRefusal | null = !rules.acceptCod
    ? "cod_off"
    : overLimit
      ? "over_limit"
      : null;

  const online = rules.acceptOnline;

  const notice = paymentNotice(cod, online, codRefusal, limit);

  return { cod, online, codRefusal, notice, noMethod: !cod && !online };
}

/** The line shown under the payment options, given what is on offer and why. */
function paymentNotice(
  cod: boolean,
  online: boolean,
  codRefusal: CodRefusal | null,
  limit: number
): string | null {
  if (!cod && !online) {
    return "This shop cannot take payment right now. Please try again a little later.";
  }
  if (codRefusal === "over_limit") {
    return online
      ? `Orders above ${rupees(limit)} must be paid online.`
      : `This shop takes cash only up to ${rupees(limit)}. Remove a few items to place this order.`;
  }
  if (codRefusal === "cod_off") {
    return online
      ? "This shop takes online payment only."
      : "This shop cannot take payment right now. Please try again a little later.";
  }
  // Cash is fine now. With no online fallback and a ceiling set, the customer
  // may be close enough to it that being told about it before they add another
  // item is a kindness — but that is `codLimitHint`'s line, not this one.
  return null;
}

/** A heads-up shown while cash is still allowed, so the ceiling isn't a surprise. */
export function codLimitHint(
  rules: VendorPaymentRules,
  orderTotal: number
): string | null {
  const limit = Math.max(0, Math.round(rules.codMaxOrder));
  if (limit <= 0 || !rules.acceptCod) return null;
  if (Math.round(orderTotal) > limit) return null;
  return `Cash on delivery is available up to ${rupees(limit)}.`;
}

/** Why an order was refused — mapped to a message by the API and the UI. */
export type PaymentRefusalCode =
  | "cod_not_available"
  | "cod_limit_exceeded"
  | "online_not_available"
  | "no_payment_method";

/**
 * The server-side gate. Returns null when the method is allowed, or the code to
 * refuse with. Called by createOrder for every order, including phone orders
 * an operator places on a customer's behalf.
 */
export function refusePayment(
  rules: VendorPaymentRules,
  method: CheckoutPaymentMethod,
  orderTotal: number
): PaymentRefusalCode | null {
  const avail = paymentAvailability(rules, orderTotal);
  if (avail.noMethod) return "no_payment_method";
  if (method === "online") return avail.online ? null : "online_not_available";
  if (avail.cod) return null;
  return avail.codRefusal === "over_limit"
    ? "cod_limit_exceeded"
    : "cod_not_available";
}

/** One message per refusal, in the same plain English the checkout uses. */
export function refusalMessage(
  code: PaymentRefusalCode,
  rules: VendorPaymentRules
): string {
  switch (code) {
    case "cod_limit_exceeded":
      return `Orders above ${rupees(rules.codMaxOrder)} must be paid online.`;
    case "cod_not_available":
      return "This shop takes online payment only.";
    case "online_not_available":
      return "Online payment isn't available for this shop — please pay cash on delivery.";
    case "no_payment_method":
      return "This shop cannot take payment right now. Please try again a little later.";
  }
}
