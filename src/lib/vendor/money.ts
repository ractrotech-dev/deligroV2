/**
 * The Partner app's money vocabulary over a vendor ledger (admin-settlements
 * `vendorLedger`), shared by the dashboard, payments and reports so the same
 * word is the same number everywhere. Pure; tested by scripts/qa/vendor-money.ts.
 *
 *   total earnings   Σ (vendorNet − refundRecovered) over delivered orders
 *   paid order       in a paid settlement
 *   unpaid order     delivered, not in a paid settlement
 *   partly paid      paid, but Deligro is recovering part of it again
 *                    (an outstanding settlement correction, 0048)
 *   payment due      Σ contribution of unpaid orders − outstanding corrections.
 *                    Positive: Deligro owes the shop. Negative: the shop owes
 *                    Deligro (cash orders, where the shop kept the money).
 */
export interface LedgerLineMoney {
  orderId: string;
  vendorNet: number;
  refundRecovered: number;
  contribution: number;
  paid: boolean;
}

export interface LedgerSummary {
  totalEarnings: number;
  paidOrders: number;
  unpaidOrders: number;
  partlyPaidOrders: number;
  paymentDue: number;
}

export function summariseLedger(
  lines: LedgerLineMoney[],
  opts: { outstandingCorrections: number; correctedOrderIds: Set<string> }
): LedgerSummary {
  let totalEarnings = 0;
  let paidOrders = 0;
  let unpaidOrders = 0;
  let partlyPaidOrders = 0;
  let unpaidContribution = 0;
  for (const l of lines) {
    totalEarnings += l.vendorNet - l.refundRecovered;
    if (l.paid) {
      paidOrders++;
      if (opts.correctedOrderIds.has(l.orderId)) partlyPaidOrders++;
    } else {
      unpaidOrders++;
      unpaidContribution += l.contribution;
    }
  }
  return {
    totalEarnings,
    paidOrders,
    unpaidOrders,
    partlyPaidOrders,
    paymentDue: unpaidContribution - opts.outstandingCorrections,
  };
}
