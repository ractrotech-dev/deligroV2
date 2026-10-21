import "server-only";
import {
  getSettlement,
  listSettlements,
  vendorLedger,
  type SettlementLine,
} from "@/lib/data-access/admin-settlements";
import { loadSaleOrders } from "@/lib/data-access/vendor-sales";
import { summariseLedger, type LedgerSummary } from "@/lib/vendor/money";
import { buildReport, type ReportFilters } from "@/lib/vendor/report";
import { shortOrderId } from "@/lib/utils/order-map";

/**
 * The Partner app's Payments screen and sales report (requirements §4, §5).
 *
 * Settlement reads go through admin-settlements (service role). Every function
 * here takes the restaurant id that `vendorApiContext()` resolved from the
 * session — never one from the request — and a statement is only returned
 * when it belongs to that shop and is not a draft. Bank details never leave:
 * a statement says where it was paid only as a masked account / UPI handle.
 */

export interface VendorSettlementSummary {
  id: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  orderCount: number;
  foodGross: number;
  charges: number;
  refundsRecovered: number;
  netPayable: number;
  status: "paid" | "void";
  paidAt: string | null;
  paymentRef: string | null;
}

export interface VendorUnpaidOrder {
  orderId: string;
  code: string;
  deliveredAt: string;
  paymentMethod: string;
  sale: number;
  charges: number;
  earnings: number;
  /** What this order adds to (or, for cash the shop kept, takes from) the next payout. */
  contribution: number;
}

export interface VendorPayments extends LedgerSummary {
  /** Σ net payable of paid settlements. */
  amountSettled: number;
  outstandingCorrections: number;
  settlementCycle: string;
  commissionPct: number;
  settlements: VendorSettlementSummary[];
  unpaid: VendorUnpaidOrder[];
}

const charges = (l: Pick<SettlementLine, "commission" | "commissionGst" | "otherCharges">) =>
  l.commission + l.commissionGst + l.otherCharges;

export async function getVendorPayments(restaurantId: string): Promise<VendorPayments | null> {
  const [ledger, list] = await Promise.all([vendorLedger(restaurantId), listSettlements(200, restaurantId)]);
  if (!ledger) return null;

  const summary = summariseLedger(ledger.lines, {
    outstandingCorrections: ledger.outstandingCorrections,
    correctedOrderIds: new Set(ledger.correctedOrderIds),
  });
  // Drafts are Deligro's work in progress, not the shop's business yet.
  const settlements = list
    .filter((s) => s.status === "paid" || s.status === "void")
    .map((s) => ({
      id: s.id,
      periodLabel: s.periodLabel,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      orderCount: s.orderCount,
      foodGross: s.foodGross,
      charges: s.commission + s.commissionGst + s.otherCharges,
      refundsRecovered: s.refundsRecovered,
      netPayable: s.netPayable,
      status: s.status as "paid" | "void",
      paidAt: s.paidAt,
      paymentRef: s.paymentRef,
    }));

  return {
    ...summary,
    amountSettled: settlements.filter((s) => s.status === "paid").reduce((n, s) => n + s.netPayable, 0),
    outstandingCorrections: ledger.outstandingCorrections,
    settlementCycle: ledger.settlementCycle,
    commissionPct: ledger.commissionPct,
    settlements,
    unpaid: ledger.lines
      .filter((l) => !l.paid)
      .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))
      .map((l) => ({
        orderId: l.orderId,
        code: l.code,
        deliveredAt: l.deliveredAt,
        paymentMethod: l.paymentMethod ?? "cod",
        sale: l.foodGross,
        charges: charges(l),
        earnings: l.vendorNet - l.refundRecovered,
        contribution: l.contribution,
      })),
  };
}

export interface VendorStatement {
  id: string;
  shopName: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: "paid" | "void";
  paidAt: string | null;
  paymentRef: string | null;
  /** "UPI ab***@okicici" / "A/c ••••1234 · HDFC"; null when none was on file. */
  paidTo: string | null;
  commissionPct: number;
  commissionGstPct: number;
  otherChargesPerOrder: number;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  refundsRecovered: number;
  netPayable: number;
  lines: {
    orderId: string;
    code: string;
    deliveredAt: string;
    paymentMethod: string;
    sale: number;
    platformDiscount: number;
    commission: number;
    commissionGst: number;
    otherCharges: number;
    refundRecovered: number;
    earnings: number;
    contribution: number;
  }[];
}

/** "abhishek@okicici" → "ab***@okicici". */
export function maskUpi(upi: string): string {
  const [name, host] = upi.split("@");
  if (!host) return `${upi.slice(0, 2)}***`;
  return `${name.slice(0, 2)}***@${host}`;
}

/** The shop's own statement; null when it isn't theirs or is still a draft. */
export async function getVendorStatement(restaurantId: string, settlementId: string): Promise<VendorStatement | null> {
  const s = await getSettlement(settlementId);
  if (!s || s.restaurantId !== restaurantId || (s.status !== "paid" && s.status !== "void")) return null;
  const p = s.payout;
  const paidTo = p.upiId
    ? `UPI ${maskUpi(p.upiId)}`
    : p.bankAccountNumber
      ? `A/c ••••${p.bankAccountNumber.slice(-4)}${p.bankName ? ` · ${p.bankName}` : ""}`
      : null;
  return {
    id: s.id,
    shopName: s.restaurantName,
    periodLabel: s.periodLabel,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    status: s.status as "paid" | "void",
    paidAt: s.paidAt,
    paymentRef: s.paymentRef,
    paidTo,
    commissionPct: p.commissionPct,
    commissionGstPct: p.commissionGstPct,
    otherChargesPerOrder: p.otherChargesPerOrder,
    foodGross: s.foodGross,
    commission: s.commission,
    commissionGst: s.commissionGst,
    otherCharges: s.otherCharges,
    refundsRecovered: s.refundsRecovered,
    netPayable: s.netPayable,
    lines: s.lines.map((l) => ({
      orderId: l.orderId,
      code: l.code,
      deliveredAt: l.deliveredAt,
      paymentMethod: l.paymentMethod ?? "cod",
      sale: l.foodGross,
      platformDiscount: l.platformDiscount,
      commission: l.commission,
      commissionGst: l.commissionGst,
      otherCharges: l.otherCharges,
      refundRecovered: l.refundRecovered,
      earnings: l.vendorNet - l.refundRecovered,
      contribution: l.contribution,
    })),
  };
}

/**
 * The sales report for [from, to). Money columns (charges, earnings,
 * settlement) only when `includeMoney` — the shop's Earnings switch.
 */
export async function getVendorReport(
  restaurantId: string,
  range: { from: Date; to: Date },
  filters: ReportFilters,
  includeMoney: boolean
) {
  const [sales, ledger] = await Promise.all([
    loadSaleOrders(restaurantId, range),
    includeMoney ? vendorLedger(restaurantId, range) : Promise.resolve(null),
  ]);
  const { rows, totals } = buildReport(sales, ledger?.lines ?? [], includeMoney ? filters : { ...filters, settled: "all" });
  return {
    rows: rows.map((r) => ({
      ...r,
      code: `#${shortOrderId(r.orderId)}`,
      ...(includeMoney ? {} : { charges: null, earnings: null, settlement: null }),
    })),
    totals: includeMoney ? totals : { ...totals, charges: null, earnings: null, settled: null, unsettled: null },
    includesMoney: includeMoney,
  };
}
