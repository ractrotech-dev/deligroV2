/**
 * Finance rules (§7) — pure. When a payment counts as failed or delayed, what
 * reconciliation state an order is in, whether a rider's cash day is settled,
 * and the rider ledger's totals. Thresholds are exported so Phase 8's alert
 * engine fires on exactly the same lines the Finance screens draw.
 *
 * No queries, no Supabase: rows in, answers out.
 */

export const FINANCE_THRESHOLDS = {
  /** An online payment still pending/authorised this long is stuck. */
  stuckPaymentMinutes: 30,
  /** An approved refund on an online order not sent to the gateway after this long. */
  refundUnsentHours: 24,
  /** Days past a shop's cycle before an unsettled order counts as late. */
  settlementGraceDays: 3,
  cycleDays: { weekly: 7, monthly: 31 },
  /** A draft settlement untouched this long. */
  draftStaleDays: 3,
  /** A payment request waiting for its checker this long. */
  approvalOverdueHours: 48,
  /** An unpaid rider ledger row this old. */
  riderPayoutDelayDays: 35,
} as const;

export type SettlementCycle = "weekly" | "monthly";

export type FinanceIssueType =
  | "failed_payment"
  | "stuck_payment"
  | "refund_unsent"
  | "settlement_delayed"
  | "draft_stale"
  | "approval_overdue"
  | "rider_payout_delayed";

export const FINANCE_ISSUE_TYPES: readonly FinanceIssueType[] = [
  "failed_payment",
  "stuck_payment",
  "refund_unsent",
  "settlement_delayed",
  "draft_stale",
  "approval_overdue",
  "rider_payout_delayed",
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How many days after its delivery an unsettled order becomes late. */
export function settlementDueDays(cycle: SettlementCycle): number {
  return FINANCE_THRESHOLDS.cycleDays[cycle] + FINANCE_THRESHOLDS.settlementGraceDays;
}

export function isStuckPayment(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > FINANCE_THRESHOLDS.stuckPaymentMinutes * 60_000;
}

/**
 * Does a pending or authorized payment count as a stuck transaction? Only
 * when money is held (authorized but not captured), or the order went ahead
 * (the kitchen accepted it) while its payment never completed. A pending
 * payment on an order still `placed` is a checkout the customer walked away
 * from — not an order, so not a transaction (design, Money definitions).
 */
export function stuckPaymentCounts(paymentStatus: string, orderStatus: string): boolean {
  if (orderStatus === "cancelled") return false;
  if (paymentStatus === "authorized") return true;
  return paymentStatus === "pending" && orderStatus !== "placed";
}

/**
 * What a shop is owed once its outstanding settlement corrections (refunds
 * recovered from money already paid, 0048) are taken off — the same
 * deduction its next settlement makes.
 */
export function vendorDueNet(net: number, outstandingCorrections: number): { payable: number; recoverable: number } {
  const after = net - outstandingCorrections;
  return { payable: Math.max(0, after), recoverable: Math.max(0, -after) };
}

export function isSettlementDelayed(cycle: SettlementCycle, oldestUnsettledAt: Date | null, now: Date): boolean {
  if (!oldestUnsettledAt) return false;
  return now.getTime() - oldestUnsettledAt.getTime() > settlementDueDays(cycle) * DAY;
}

/**
 * Critical: a failed payment always; a settlement late by more than twice its
 * own threshold; an approval waiting over 96 h; a rider unpaid over 45 days.
 * Everything else is a warning.
 */
export function issueSeverity(type: FinanceIssueType, ageHours: number): "warning" | "critical" {
  switch (type) {
    case "failed_payment":
      return "critical";
    case "settlement_delayed":
      return ageHours > 2 * settlementDueDays("weekly") * 24 ? "critical" : "warning";
    case "approval_overdue":
      return ageHours > 96 ? "critical" : "warning";
    case "rider_payout_delayed":
      return ageHours > 45 * 24 ? "critical" : "warning";
    default:
      return "warning";
  }
}

export type ReconciliationState =
  | "paid_matched"
  | "paid_mismatch"
  | "correction_outstanding"
  | "in_draft"
  | "unsettled_due"
  | "unsettled_recent";

export const RECONCILIATION_STATES: readonly ReconciliationState[] = [
  "paid_matched",
  "paid_mismatch",
  "correction_outstanding",
  "in_draft",
  "unsettled_due",
  "unsettled_recent",
];

/**
 * One delivered order against the settlement that paid it.
 *
 * `expectedContribution` is the settlement arithmetic re-run with the refunds
 * approved today; a paid line that no longer matches it is covered when a
 * correction (outstanding or applied) recovers exactly the drop.
 * `difference` = expected − settled (after applied corrections) for a paid
 * line; the whole expected contribution for an order with no line.
 */
export function classifyOrderReconciliation(input: {
  delivered: boolean;
  deliveredAt: Date;
  cycle: SettlementCycle;
  line: { settlementStatus: "draft" | "paid"; contribution: number } | null;
  expectedContribution: number;
  outstandingCorrection: number;
  appliedCorrection: number;
  now: Date;
}): { state: ReconciliationState; difference: number } {
  const { line, expectedContribution } = input;
  if (!line) {
    const late = isSettlementDelayed(input.cycle, input.deliveredAt, input.now);
    return { state: late ? "unsettled_due" : "unsettled_recent", difference: expectedContribution };
  }
  if (line.settlementStatus === "draft") {
    return { state: "in_draft", difference: expectedContribution - line.contribution };
  }
  const settledAfterApplied = line.contribution - input.appliedCorrection;
  const difference = expectedContribution - settledAfterApplied;
  if (difference === 0) return { state: "paid_matched", difference: 0 };
  if (input.outstandingCorrection > 0 && expectedContribution === settledAfterApplied - input.outstandingCorrection) {
    return { state: "correction_outstanding", difference };
  }
  return { state: "paid_mismatch", difference };
}

export type OnlinePaymentState = "matched" | "online_mismatch" | "missing_payment";

export function classifyOnlinePayment(orderTotal: number, paidPaise: number | null): OnlinePaymentState {
  if (paidPaise === null) return "missing_payment";
  return Math.round(paidPaise) === Math.round(orderTotal * 100) ? "matched" : "online_mismatch";
}

export type CashDayStatus = "settled" | "pending" | "disputed";

export function cashDayStatus(collected: number, deposited: number, disputed: boolean): CashDayStatus {
  if (disputed) return "disputed";
  return deposited >= collected ? "settled" : "pending";
}

/** A ledger row's sign: deductions take money away, everything else adds. */
export function ledgerSign(type: string): 1 | -1 {
  return type === "deduction" ? -1 : 1;
}

const paise = (rupees: number) => Math.round(rupees * 100);

/**
 * Rider ledger figures (2 decimals, summed in paise so they never drift):
 * signed sum of rows dated in `range` (all rows without one), what is unpaid
 * (rows not attached to a payout), and the oldest unpaid date.
 */
export function riderLedgerTotals(
  rows: { type: string; amount: number; date: string; payoutId: string | null }[],
  range?: { from: string; to: string }
): { earnedInRange: number; unpaid: number; oldestUnpaidOn: string | null } {
  let earned = 0;
  let unpaid = 0;
  let oldest: string | null = null;
  for (const r of rows) {
    const signed = ledgerSign(r.type) * paise(r.amount);
    if (!range || (r.date >= range.from && r.date <= range.to)) earned += signed;
    if (r.payoutId === null) {
      unpaid += signed;
      if (oldest === null || r.date < oldest) oldest = r.date;
    }
  }
  return { earnedInRange: earned / 100, unpaid: unpaid / 100, oldestUnpaidOn: oldest };
}

/** Hours between two instants (for severity). */
export function ageHours(since: Date, now: Date): number {
  return (now.getTime() - since.getTime()) / HOUR;
}
