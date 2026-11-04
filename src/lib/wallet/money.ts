/**
 * The customer wallet's arithmetic and words. Pure and client-safe: the checkout,
 * the rider's screens and the server all decide from these, so what a person is
 * shown can't drift from what runs. The database decides for real (0198).
 *
 * `orders.total` stays the full bill. Everything that means "cash at the door" is
 * `cashDue(total, pointsUsed)`, not `total`.
 */

/** Rupees the rider collects: the bill less the points on it. Never below zero. */
export function cashDue(total: number | null | undefined, pointsUsed: number | null | undefined): number {
  return Math.max(0, Math.round(Number(total ?? 0)) - Math.max(0, Math.round(Number(pointsUsed ?? 0))));
}

/** The most a customer can use on this bill: their balance, up to the bill. */
export function maxPointsFor(balance: number, total: number): number {
  return Math.max(0, Math.min(Math.floor(Number(balance) || 0), Math.round(Number(total) || 0)));
}

/**
 * What the customer asked to use, as a whole number of points, or null when it isn't
 * one. Absent or 0 is "none": a real answer, unlike 2.5 or "a lot".
 */
export function parseWalletPoints(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 10_000_000) return null;
  return raw;
}

export type WalletKind =
  | "legacy"
  | "change_credit"
  | "order_spend"
  | "order_return"
  | "order_adjust"
  | "admin_correction";

export const WALLET_KINDS: WalletKind[] = [
  "change_credit",
  "order_spend",
  "order_return",
  "order_adjust",
  "admin_correction",
  "legacy",
];

/** A ledger row in the words a person reads. */
export function walletKindLabel(kind: string): string {
  switch (kind) {
    case "change_credit":
      return "Change added";
    case "order_spend":
      return "Used on an order";
    case "order_return":
      return "Returned, order cancelled";
    case "order_adjust":
      return "Returned, bill went down";
    case "admin_correction":
      return "Corrected by Deligro";
    case "legacy":
      return "Opening balance";
    default:
      return "Wallet";
  }
}

/** "+₹50" / "−₹30". */
export function signedRupees(amount: number): string {
  const n = Math.round(Number(amount) || 0);
  return `${n < 0 ? "−" : "+"}₹${Math.abs(n).toLocaleString("en-IN")}`;
}

/** Why the rider's "add to wallet" was refused, in words they can act on. */
export type WalletChangeError =
  | "wallet_off"
  | "not_yours"
  | "not_active"
  | "no_cash_due"
  | "cash_already_recorded"
  | "no_change"
  | "over_limit"
  | "no_code"
  | "locked"
  | "code_expired"
  | "wrong_code";

export function walletChangeMessage(
  error: string,
  ctx: { limit?: number; triesLeft?: number; cashDue?: number } = {},
): string {
  switch (error) {
    case "wallet_off":
      return "The wallet is switched off. Give the change in cash.";
    case "not_yours":
      return "This isn't your delivery.";
    case "not_active":
      return "This delivery is no longer active.";
    case "no_cash_due":
      return "There is no cash to collect on this order.";
    case "cash_already_recorded":
      return "Cash is already recorded for this order.";
    case "no_change":
      return ctx.cashDue
        ? `The amount received must be more than ₹${ctx.cashDue}.`
        : "The amount received must be more than the cash due.";
    case "over_limit":
      return ctx.limit
        ? `That is more than the ₹${ctx.limit} you can add. Give the change in cash.`
        : "That is more than you can add. Give the change in cash.";
    case "no_code":
      return "Ask the customer to open the order in the app and tap Get code.";
    case "locked":
      return "Too many wrong codes. Give the change in cash and finish the delivery.";
    case "code_expired":
      return "That code has run out. Ask the customer to get a new one.";
    case "wrong_code":
      return ctx.triesLeft
        ? `Wrong code. ${ctx.triesLeft} ${ctx.triesLeft === 1 ? "try" : "tries"} left.`
        : "Wrong code.";
    default:
      return "That didn't go through. Try again, or give the change in cash.";
  }
}

/** Why a customer's points couldn't be used, in words they can act on. */
export function walletSpendMessage(error: string, balance?: number): string {
  switch (error) {
    case "wallet_off":
      return "The wallet is switched off right now. Please pay in cash.";
    case "insufficient":
      return balance !== undefined
        ? `You have ${Math.floor(balance)} points. Use that many or fewer.`
        : "You don't have that many points.";
    case "over_bill":
      return "You can't use more points than the bill.";
    case "invalid_points":
      return "Points must be a whole number.";
    case "cash_orders_only":
      return "Points can only be used on cash orders for now.";
    default:
      return "Your points couldn't be used. Please try again.";
  }
}

/** Why a customer can't get a code right now. */
export function walletCodeMessage(error: string): string {
  switch (error) {
    case "wallet_off":
      return "The wallet is switched off right now.";
    case "not_out_for_delivery":
      return "You can get a code once your order is on the way.";
    case "no_cash_due":
      return "There is no cash to pay on this order.";
    case "already_added":
      return "The change on this order has already been added.";
    case "locked":
      return "Too many wrong codes were tried on this order. Take your change in cash.";
    default:
      return "Couldn't get a code. Please try again.";
  }
}

/** The admin's correction, checked before anything is sent. */
export function checkCorrection(
  rawAmount: unknown,
  rawReason: unknown,
): { ok: true; delta: number; reason: string } | { ok: false; error: string } {
  const text = typeof rawAmount === "string" ? rawAmount.trim() : String(rawAmount ?? "");
  if (!/^[+-]?\d{1,6}$/.test(text)) {
    return { ok: false, error: "Enter a whole number of points, for example 50 or -50." };
  }
  const delta = Number(text);
  if (delta === 0 || Math.abs(delta) > 100_000) {
    return { ok: false, error: "The correction must be between 1 and 100,000 points, up or down." };
  }
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    return { ok: false, error: "Write the reason (5 to 500 characters)." };
  }
  return { ok: true, delta, reason };
}

/** The refusal from `wallet_admin_correct`, in the admin's words. */
export function correctionMessage(error: string): string {
  switch (error) {
    case "reason_required":
      return "Write the reason (5 to 500 characters).";
    case "invalid_amount":
      return "The correction must be between 1 and 100,000 points, up or down.";
    case "would_go_negative":
      return "That would take the balance below zero.";
    case "not_found":
      return "That customer isn't there any more.";
    default:
      return "That didn't go through. Try again.";
  }
}
