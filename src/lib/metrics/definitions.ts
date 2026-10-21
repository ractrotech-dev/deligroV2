/**
 * The money and order definitions every ops screen uses (design "Money
 * definitions"). One function per figure, each over the rows it is handed —
 * the caller decides the period and the scope, this module decides the
 * arithmetic.
 *
 * Commission, payout and refund direction come from `@/lib/settlements/math`
 * and nowhere else, so a dashboard tile, a report row and the settlement that
 * paid the order agree to the rupee.
 */
import { breakdownOrder, type SettlementOrderBreakdown } from "@/lib/settlements/math";
import { inRange } from "./ist";
import type {
  DateRange,
  Growth,
  MetricOrder,
  MetricRefund,
  MetricSettlement,
  PricingContext,
} from "./types";

const rupees = (n: number) => Math.round(Number(n) || 0);

export const PENDING_STATUSES = ["placed", "kitchen", "ready", "on_the_way"] as const;

/**
 * Online payment states in which the customer's money actually reached the
 * platform. 'authorized' is Razorpay's captured-not-settled state (0025);
 * 'refunded' was paid first.
 */
const COUNTED_ONLINE_PAYMENTS: readonly string[] = ["authorized", "paid", "refunded"];

/**
 * Is this row an order at all? An online checkout the customer never paid for
 * (payment pending or failed) is an abandoned attempt, not an order: it is left
 * out of every figure — sales, orders, pending, cancelled, commission, AOV.
 * COD orders always count. This predicate is the one place that decides it;
 * `ops_counts_as_order()` (migration 0144) is its SQL twin.
 */
export function isCountedOrder(o: Pick<MetricOrder, "paymentMethod" | "paymentStatus">): boolean {
  return o.paymentMethod !== "online" || COUNTED_ONLINE_PAYMENTS.includes(o.paymentStatus ?? "");
}

/** The rows that are orders — see `isCountedOrder`. */
export function countedOrders(orders: MetricOrder[]): MetricOrder[] {
  return orders.filter(isCountedOrder);
}

export function isCancelled(o: MetricOrder): boolean {
  return o.status === "cancelled";
}

/** Delivered — the order's lifecycle is complete. */
export function isCompleted(o: MetricOrder): boolean {
  return o.status === "delivered";
}

/** Still in flight: placed, in the kitchen, ready, or on the way. */
export function isPending(o: MetricOrder): boolean {
  return (PENDING_STATUSES as readonly string[]).includes(o.status);
}

/** Orders that count as sales: every counted order not cancelled, in flight included. */
export function salesOrders(orders: MetricOrder[]): MetricOrder[] {
  return orders.filter((o) => isCountedOrder(o) && !isCancelled(o));
}

/**
 * The food sold on one order before any discount: qty × price over its lines.
 *
 * Without lines, the order's own figures give the same number —
 * total − delivery fee − tax − tip + discount — since `orders.total` is net of
 * the discount (0031) and the lines are what the subtotal was built from.
 */
export function itemsSubtotal(o: MetricOrder): number {
  if (o.items && o.items.length > 0) {
    return o.items.reduce((sum, i) => sum + rupees(i.qty) * rupees(i.price), 0);
  }
  return Math.max(
    0,
    rupees(o.total) - rupees(o.deliveryFee) - rupees(o.taxAmount) - rupees(o.tip) + rupees(o.discount)
  );
}

/** Gross sales: items subtotal of non-cancelled orders, before discounts. */
export function grossSales(orders: MetricOrder[]): number {
  return salesOrders(orders).reduce((sum, o) => sum + itemsSubtotal(o), 0);
}

/** What customers paid on non-cancelled orders — the "sales" every existing report sums. */
export function customerPaid(orders: MetricOrder[]): number {
  return salesOrders(orders).reduce((sum, o) => sum + rupees(o.total), 0);
}

export interface DiscountSplit {
  /** Funded by the shop — `discount_funded_by` vendor, or null (settlement math's rule). */
  vendor: number;
  /** Funded by Deligro. */
  platform: number;
  total: number;
}

/** Discounts on non-cancelled orders, split by who paid for them. */
export function discountsByFunder(orders: MetricOrder[]): DiscountSplit {
  const split: DiscountSplit = { vendor: 0, platform: 0, total: 0 };
  for (const o of salesOrders(orders)) {
    const d = Math.max(0, rupees(o.discount));
    if (d === 0) continue;
    if (o.discountFundedBy === "platform") split.platform += d;
    else split.vendor += d;
    split.total += d;
  }
  return split;
}

export interface RefundTotals {
  /** Approved refunds on non-cancelled orders — the ones that reduce net sales. */
  total: number;
  /** How many distinct refunds make up `total`. */
  count: number;
  /**
   * Approved refunds on cancelled orders. Reported, never subtracted: the
   * cancelled order is already out of net sales, and taking its refund off as
   * well would count the same money twice.
   */
  onCancelled: number;
}

/**
 * Approved refunds attributed to these orders — and therefore to the orders'
 * dates, not the refund's. Each refund counts once by id, however many times a
 * join lists it; refunds on orders outside the set are ignored.
 */
export function approvedRefunds(orders: MetricOrder[], refunds: MetricRefund[]): RefundTotals {
  const statusOf = new Map(countedOrders(orders).map((o) => [o.id, o.status]));
  const seen = new Set<string>();
  const totals: RefundTotals = { total: 0, count: 0, onCancelled: 0 };
  for (const r of refunds) {
    if (r.status !== "approved" || seen.has(r.id)) continue;
    const status = statusOf.get(r.orderId);
    if (status === undefined) continue;
    seen.add(r.id);
    const amount = Math.max(0, rupees(r.amount));
    if (status === "cancelled") {
      totals.onCancelled += amount;
    } else {
      totals.total += amount;
      totals.count += 1;
    }
  }
  return totals;
}

/** Approved refunds per order id, deduplicated — the settlement arithmetic's input. */
export function refundsByOrder(refunds: MetricRefund[]): Map<string, number> {
  const seen = new Set<string>();
  const byOrder = new Map<string, number>();
  for (const r of refunds) {
    if (r.status !== "approved" || seen.has(r.id)) continue;
    seen.add(r.id);
    byOrder.set(r.orderId, (byOrder.get(r.orderId) ?? 0) + Math.max(0, rupees(r.amount)));
  }
  return byOrder;
}

/** Net sales: gross − every discount − approved refunds. Cancelled orders are not in it. */
export function netSales(orders: MetricOrder[], refunds: MetricRefund[]): number {
  return grossSales(orders) - discountsByFunder(orders).total - approvedRefunds(orders, refunds).total;
}

/** Cancelled orders, kept apart: how many, and what they would have been worth. */
export function cancelledSummary(orders: MetricOrder[]): { count: number; value: number } {
  let count = 0;
  let value = 0;
  for (const o of countedOrders(orders)) {
    if (!isCancelled(o)) continue;
    count += 1;
    value += rupees(o.total);
  }
  return { count, value };
}

/** Delivery fees on non-cancelled orders. */
export function deliveryFees(orders: MetricOrder[]): number {
  return salesOrders(orders).reduce((sum, o) => sum + rupees(o.deliveryFee), 0);
}

/** Average order value: customer paid ÷ non-cancelled orders; 0 with no orders. */
export function averageOrderValue(orders: MetricOrder[]): number {
  const n = salesOrders(orders).length;
  return n === 0 ? 0 : Math.round(customerPaid(orders) / n);
}

/** Completed ÷ all and cancelled ÷ all, as fractions; 0 with no orders. */
export function orderRates(all: MetricOrder[]): { completionRate: number; cancellationRate: number } {
  const orders = countedOrders(all);
  if (orders.length === 0) return { completionRate: 0, cancellationRate: 0 };
  const completed = orders.filter(isCompleted).length;
  const cancelled = orders.filter(isCancelled).length;
  return {
    completionRate: completed / orders.length,
    cancellationRate: cancelled / orders.length,
  };
}

/** Change against the previous period. See `Growth.pct` for the zero case. */
export function growth(current: number, previous: number): Growth {
  const change = current - previous;
  let pct: number | null;
  if (previous === 0) pct = current === 0 ? 0 : null;
  else pct = Math.round((change / Math.abs(previous)) * 1000) / 10;
  return { current, previous, change, pct };
}

/** One order through the shared settlement arithmetic. */
export function priceOrder(
  o: MetricOrder,
  pricing: PricingContext,
  refundsForOrder: number
): SettlementOrderBreakdown {
  return breakdownOrder({
    total: rupees(o.total),
    deliveryFee: rupees(o.deliveryFee),
    taxAmount: rupees(o.taxAmount),
    tip: rupees(o.tip),
    discount: rupees(o.discount),
    discountFundedBy: o.discountFundedBy === "platform" ? "platform" : "vendor",
    commissionPct: pricing.commissionPct.get(o.restaurantId) ?? 0,
    commissionGstPct: pricing.commissionGstPct,
    otherCharges: pricing.otherCharges.get(o.restaurantId) ?? 0,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    approvedRefunds: refundsForOrder,
  });
}

export interface CommissionTotals {
  commission: number;
  commissionGst: number;
  otherCharges: number;
  /** Everything the platform keeps: commission + GST on it + other charges. */
  total: number;
}

/** Platform commission on non-cancelled orders, per the settlement arithmetic. */
export function platformCommission(
  orders: MetricOrder[],
  refunds: MetricRefund[],
  pricing: PricingContext
): CommissionTotals {
  const byOrder = refundsByOrder(refunds);
  const totals: CommissionTotals = { commission: 0, commissionGst: 0, otherCharges: 0, total: 0 };
  for (const o of salesOrders(orders)) {
    const b = priceOrder(o, pricing, byOrder.get(o.id) ?? 0);
    totals.commission += b.commission;
    totals.commissionGst += b.commissionGst;
    totals.otherCharges += b.otherCharges;
  }
  totals.total = totals.commission + totals.commissionGst + totals.otherCharges;
  return totals;
}

export interface VendorBalance {
  /** Net of every unpaid completed order's settlement line; negative = the shop owes. */
  net: number;
  orderIds: string[];
}

export interface VendorEarnings {
  /** Owed to shops: the sum of each shop's positive balance. */
  payable: number;
  /** Owed by shops (COD commission not yet recovered): the sum of negative balances. */
  recoverable: number;
  byVendor: Map<string, VendorBalance>;
}

/**
 * What shops are owed for completed orders not yet in a paid settlement — the
 * same `contribution` a settlement would compute, netted per shop. A shop whose
 * COD commission exceeds its online remittance owes the platform; that is
 * `recoverable`, never a negative "payment due".
 */
export function vendorEarnings(
  orders: MetricOrder[],
  refunds: MetricRefund[],
  pricing: PricingContext,
  paidOrderIds: ReadonlySet<string>
): VendorEarnings {
  const byOrder = refundsByOrder(refunds);
  const byVendor = new Map<string, VendorBalance>();
  for (const o of countedOrders(orders)) {
    if (!isCompleted(o) || paidOrderIds.has(o.id)) continue;
    const line = priceOrder(o, pricing, byOrder.get(o.id) ?? 0);
    const bal = byVendor.get(o.restaurantId) ?? { net: 0, orderIds: [] };
    bal.net += line.contribution;
    bal.orderIds.push(o.id);
    byVendor.set(o.restaurantId, bal);
  }
  let payable = 0;
  let recoverable = 0;
  for (const bal of byVendor.values()) {
    if (bal.net > 0) payable += bal.net;
    else recoverable += -bal.net;
  }
  return { payable, recoverable, byVendor };
}

/** Paid settlements, optionally only those paid inside a range. */
export function vendorPaymentsCompleted(
  settlements: MetricSettlement[],
  range?: DateRange
): { amount: number; count: number } {
  let amount = 0;
  let count = 0;
  for (const s of settlements) {
    if (s.status !== "paid") continue;
    if (range && (!s.paidAt || !inRange(s.paidAt, range))) continue;
    amount += rupees(s.netPayable);
    count += 1;
  }
  return { amount, count };
}

export interface SalesSummary {
  /** Non-cancelled orders. */
  orders: number;
  grossSales: number;
  customerPaid: number;
  discounts: DiscountSplit;
  refunds: RefundTotals;
  netSales: number;
  cancelled: { count: number; value: number };
  deliveryFees: number;
  averageOrderValue: number;
}

/** Every sales figure for a set of orders, in one object the screens and reports share. */
export function salesSummary(orders: MetricOrder[], refunds: MetricRefund[]): SalesSummary {
  const discounts = discountsByFunder(orders);
  const refundTotals = approvedRefunds(orders, refunds);
  const gross = grossSales(orders);
  return {
    orders: salesOrders(orders).length,
    grossSales: gross,
    customerPaid: customerPaid(orders),
    discounts,
    refunds: refundTotals,
    netSales: gross - discounts.total - refundTotals.total,
    cancelled: cancelledSummary(orders),
    deliveryFees: deliveryFees(orders),
    averageOrderValue: averageOrderValue(orders),
  };
}
