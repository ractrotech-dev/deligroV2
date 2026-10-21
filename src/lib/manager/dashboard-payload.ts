/**
 * The manager dashboard's answer (§1): the eighteen figures in the client
 * document's order, with what this person may not see left out and what the
 * platform cannot count yet marked as such. Pure; the route assembles the
 * inputs.
 */
import type { Dashboard, DashboardFigures } from "@/lib/metrics/dashboard";
import type { UnavailableKey } from "@/lib/data-access/ops-metrics";

export type FigureKey = keyof DashboardFigures;

/** The document's order: §1 items 1–18. The app draws tiles in this order. */
export const FIGURE_ORDER: readonly FigureKey[] = [
  "todaysTotalSales",
  "totalSales",
  "todaysOrders",
  "totalOrders",
  "pendingOrders",
  "completedOrders",
  "cancelledOrders",
  "activeVendors",
  "onlineVendors",
  "activeRiders",
  "onlineRiders",
  "ridersOnDelivery",
  "totalDeliveryFees",
  "totalPlatformCommission",
  "vendorPaymentsDue",
  "riderPaymentsDue",
  "pendingMarketingRequests",
  "pendingSupportTickets",
];

/** Shown only with `manager.finance.view`; otherwise absent from the payload. */
export const FINANCE_FIGURES: readonly FigureKey[] = [
  "totalDeliveryFees",
  "totalPlatformCommission",
  "vendorPaymentsDue",
  "riderPaymentsDue",
];

export interface DashboardPayload {
  /** The IST day "today" refers to. */
  today: string;
  generatedAt: string;
  zone: string | null;
  /** The figures this person sees, in order. */
  order: FigureKey[];
  /** Null = the platform cannot count this yet (see `unavailable`). */
  figures: Partial<Record<FigureKey, number | null>>;
  unavailable: FigureKey[];
}

export function dashboardPayload(
  d: Dashboard,
  opts: { canSeeFinance: boolean; unavailable: readonly UnavailableKey[]; zone: string | null; now: Date }
): DashboardPayload {
  const order = FIGURE_ORDER.filter((k) => opts.canSeeFinance || !FINANCE_FIGURES.includes(k));
  const missing = new Set<FigureKey>(opts.unavailable);
  const figures: Partial<Record<FigureKey, number | null>> = {};
  for (const k of order) figures[k] = missing.has(k) ? null : d.figures[k];
  return {
    today: d.today,
    generatedAt: opts.now.toISOString(),
    zone: opts.zone,
    order,
    figures,
    unavailable: order.filter((k) => missing.has(k)),
  };
}
