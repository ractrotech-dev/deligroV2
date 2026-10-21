/**
 * The manager dashboard's eighteen figures (spec §1), in the document's order
 * and computed only from `definitions.ts`, so a tile and the report it taps
 * through to always show the same number.
 *
 * The vendor, rider, marketing and support counts are inputs: they come from
 * status tables (restaurants, rider_status, marketing_requests,
 * support_tickets), not from orders, and the data layer counts them with the
 * same scope it used for the orders.
 */
import {
  customerPaid,
  deliveryFees,
  isCancelled,
  isCompleted,
  isPending,
  platformCommission,
  vendorEarnings,
} from "./definitions";
import { inRange, istDayKey } from "./ist";
import type { DateRange, MetricOrder, MetricRefund, PricingContext } from "./types";

export interface DashboardCounts {
  activeVendors: number;
  onlineVendors: number;
  activeRiders: number;
  onlineRiders: number;
  ridersOnDelivery: number;
  /** From the rider ledger: recorded salary and adjustments not yet paid. */
  riderPaymentsDue: number;
  pendingMarketingRequests: number;
  pendingSupportTickets: number;
}

export interface DashboardFigures {
  todaysTotalSales: number;
  totalSales: number;
  todaysOrders: number;
  totalOrders: number;
  pendingOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  activeVendors: number;
  onlineVendors: number;
  activeRiders: number;
  onlineRiders: number;
  ridersOnDelivery: number;
  totalDeliveryFees: number;
  totalPlatformCommission: number;
  vendorPaymentsDue: number;
  riderPaymentsDue: number;
  pendingMarketingRequests: number;
  pendingSupportTickets: number;
}

export interface DashboardOptions {
  /** "Today" is the IST day containing this instant. */
  now: Date;
  refunds: MetricRefund[];
  pricing: PricingContext;
  /** Orders already in a paid settlement — excluded from vendor payments due. */
  paidOrderIds: ReadonlySet<string>;
  counts: DashboardCounts;
  /**
   * The window the "Total …" figures cover. Omitted = every row handed in
   * (all time, as far as the caller loaded).
   */
  range?: DateRange;
}

export interface Dashboard {
  /** The IST day "today" refers to. */
  today: string;
  figures: DashboardFigures;
}

export function computeDashboard(orders: MetricOrder[], opts: DashboardOptions): Dashboard {
  const range = opts.range;
  const scoped = range ? orders.filter((o) => inRange(o.createdAt, range)) : orders;
  const today = istDayKey(opts.now);
  const todays = orders.filter((o) => istDayKey(o.createdAt) === today);
  const c = opts.counts;

  return {
    today,
    figures: {
      todaysTotalSales: customerPaid(todays),
      totalSales: customerPaid(scoped),
      todaysOrders: todays.length,
      totalOrders: scoped.length,
      pendingOrders: scoped.filter(isPending).length,
      completedOrders: scoped.filter(isCompleted).length,
      cancelledOrders: scoped.filter(isCancelled).length,
      activeVendors: c.activeVendors,
      onlineVendors: c.onlineVendors,
      activeRiders: c.activeRiders,
      onlineRiders: c.onlineRiders,
      ridersOnDelivery: c.ridersOnDelivery,
      totalDeliveryFees: deliveryFees(scoped),
      totalPlatformCommission: platformCommission(scoped, opts.refunds, opts.pricing).total,
      vendorPaymentsDue: vendorEarnings(scoped, opts.refunds, opts.pricing, opts.paidOrderIds).payable,
      riderPaymentsDue: c.riderPaymentsDue,
      pendingMarketingRequests: c.pendingMarketingRequests,
      pendingSupportTickets: c.pendingSupportTickets,
    },
  };
}
