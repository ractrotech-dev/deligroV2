/**
 * The shapes `ops_finance_rollup` (migration 0157) returns, and the figures
 * built from them — pure. The SQL is the mirror of `src/lib/metrics`; these
 * functions only rename, zero-fill and derive (net sales = gross − discounts −
 * refunds, exactly `salesSummary`'s rule).
 * `scripts/qa/manager-finance-sql-parity.ts` holds SQL and metrics equal.
 */
import { daysInRange, type DateRange } from "@/lib/metrics";

export interface FinanceRollupSummary {
  orders: number;
  delivered: number;
  grossSales: number;
  customerPaid: number;
  discountVendor: number;
  discountPlatform: number;
  refundsTotal: number;
  refundsCount: number;
  refundsOnCancelled: number;
  cancelledCount: number;
  cancelledValue: number;
  deliveryFees: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  foodGross: number;
  vendorNet: number;
}

export interface FinanceRollupDay {
  date: string;
  orders: number;
  customerPaid: number;
  grossSales: number;
  discountVendor: number;
  discountPlatform: number;
  refunds: number;
  deliveryFees: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  cancelledCount: number;
  cancelledValue: number;
}

export interface FinanceRollupVendor {
  restaurantId: string;
  orders: number;
  delivered: number;
  cancelled: number;
  customerPaid: number;
  grossSales: number;
  discounts: number;
  refunds: number;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  vendorNet: number;
}

export interface FinanceRollup {
  summary: FinanceRollupSummary;
  byDay: FinanceRollupDay[];
  byVendor: FinanceRollupVendor[];
}

export interface FinanceSales {
  orders: number;
  grossSales: number;
  customerPaid: number;
  netSales: number;
  discounts: { vendor: number; platform: number; total: number };
  refunds: { total: number; count: number; onCancelled: number };
  platformCommission: { commission: number; commissionGst: number; otherCharges: number; total: number };
  deliveryFees: number;
  cancelled: { count: number; value: number };
  foodGross: number;
  vendorNet: number;
}

const n = (v: unknown) => Number(v) || 0;

export function salesFromRollup(s: FinanceRollupSummary): FinanceSales {
  const discounts = { vendor: n(s.discountVendor), platform: n(s.discountPlatform), total: n(s.discountVendor) + n(s.discountPlatform) };
  const refunds = { total: n(s.refundsTotal), count: n(s.refundsCount), onCancelled: n(s.refundsOnCancelled) };
  const commission = n(s.commission);
  const commissionGst = n(s.commissionGst);
  const otherCharges = n(s.otherCharges);
  return {
    orders: n(s.orders),
    grossSales: n(s.grossSales),
    customerPaid: n(s.customerPaid),
    netSales: n(s.grossSales) - discounts.total - refunds.total,
    discounts,
    refunds,
    platformCommission: { commission, commissionGst, otherCharges, total: commission + commissionGst + otherCharges },
    deliveryFees: n(s.deliveryFees),
    cancelled: { count: n(s.cancelledCount), value: n(s.cancelledValue) },
    foodGross: n(s.foodGross),
    vendorNet: n(s.vendorNet),
  };
}

export interface FinanceDayPoint {
  date: string;
  orders: number;
  customerPaid: number;
  grossSales: number;
  discountsVendor: number;
  discountsPlatform: number;
  refunds: number;
  netSales: number;
  deliveryFees: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  cancelledCount: number;
  cancelledValue: number;
}

/** One point per IST day of the range, zero-filled (a quiet day is a real data point). */
export function dailyFromFinanceRollup(r: FinanceRollup, range: DateRange): FinanceDayPoint[] {
  const byDate = new Map(r.byDay.map((d) => [d.date, d]));
  return daysInRange(range).map((date) => {
    const d = byDate.get(date);
    const dv = n(d?.discountVendor);
    const dp = n(d?.discountPlatform);
    const refunds = n(d?.refunds);
    return {
      date,
      orders: n(d?.orders),
      customerPaid: n(d?.customerPaid),
      grossSales: n(d?.grossSales),
      discountsVendor: dv,
      discountsPlatform: dp,
      refunds,
      netSales: n(d?.grossSales) - dv - dp - refunds,
      deliveryFees: n(d?.deliveryFees),
      commission: n(d?.commission),
      commissionGst: n(d?.commissionGst),
      otherCharges: n(d?.otherCharges),
      cancelledCount: n(d?.cancelledCount),
      cancelledValue: n(d?.cancelledValue),
    };
  });
}

export interface VendorDueRollupRow {
  restaurantId: string;
  net: number;
  orders: number;
  oldestDeliveredAt: string | null;
  lastPaidAt: string | null;
  outstandingCorrections: number;
}

export interface RiderDueRollupRow {
  riderId: string;
  unpaid: number;
  oldestUnpaidOn: string | null;
  lastPayout: { amount: number; paidOn: string; reference: string | null } | null;
}

export interface ReconciliationRollupItem {
  orderId: string;
  orderCode: string | null;
  restaurantId: string;
  deliveredAt: string;
  state: string;
  expected: number;
  settled: number | null;
  difference: number;
  settlementId: string | null;
  correctionId: string | null;
}

export interface CashRiderDay {
  day: string;
  riderId: string;
  codOrders: number;
  collected: number;
  deposited: number;
  disputed: boolean;
  depositIds: string[];
}

export interface CashManagerDay {
  day: string;
  managerId: string;
  received: number;
  handedOn: number;
}
