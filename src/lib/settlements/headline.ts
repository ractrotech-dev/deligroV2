/**
 * The sentence at the top of Admin → Settlements. Pure, so
 * scripts/qa/admin-money-screens.ts can check every case: "Every shop is paid" is
 * the one thing this screen must never say while money is still owed.
 */
export interface SettlementHeadlineInput {
  /** Orders not in any payment yet, across shops owed money. */
  toSend: number;
  toSendShops: number;
  /** Payments built and not finished. */
  unfinishedAmount: number;
  unfinishedCount: number;
  /** Shops whose old refunds and charges came to more than their orders. */
  owedBack: number;
  owedBackShops: number;
  /** Too many orders to add up at once, so the figures are a floor. */
  truncated: boolean;
}

export interface SettlementHeadline {
  title: string;
  /** The big figure, when there is money to send. */
  amount: number | null;
  /** The rest of what is true, one short sentence each. */
  notes: string[];
}

const shops = (n: number) => `${n} shop${n === 1 ? "" : "s"}`;
const payments = (n: number) => `${n} payment${n === 1 ? "" : "s"}`;
const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function settlementHeadline(i: SettlementHeadlineInput): SettlementHeadline {
  const notes: string[] = [];
  let title: string;
  let amount: number | null = null;

  if (i.toSend > 0) {
    title = `Send to ${shops(i.toSendShops)}`;
    amount = i.toSend;
    if (i.unfinishedCount > 0) {
      notes.push(`Plus ${rupees(i.unfinishedAmount)} in ${payments(i.unfinishedCount)} not finished.`);
    }
  } else if (i.unfinishedCount > 0) {
    title = `Finish ${payments(i.unfinishedCount)}`;
    amount = i.unfinishedAmount;
  } else if (i.owedBackShops > 0 || i.truncated) {
    title = "Nothing to send right now";
  } else {
    title = "Every shop is paid";
  }

  if (i.owedBackShops > 0) {
    notes.push(`${shops(i.owedBackShops)} owe${i.owedBackShops === 1 ? "s" : ""} you ${rupees(i.owedBack)}. It comes off their next payment.`);
  }
  return { title, amount, notes };
}
