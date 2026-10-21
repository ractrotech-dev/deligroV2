/**
 * The admin overview's figures, from the same definitions as the manager
 * dashboard (design §18.4). Pure: the admin data layer loads the rows
 * (`loadMetricOrders({ all: true }, …)`) and calls these.
 *
 * The admin tiles keep their own windows — "today" is the IST day, the trend
 * arrows compare the last 7 × 24 hours with the 7 × 24 before — but every sum
 * inside them is a metrics function, so "Revenue today" on the admin overview
 * and "Today's Total Sales" for an all-zones manager are one number.
 * scripts/qa/admin-metrics-parity.ts pins this against the loops it replaced.
 */
import { customerPaid, platformCommission, salesOrders } from "./definitions";
import { istDayKey, istDayStart } from "./ist";
import { dailySeries } from "./stats";
import type { DateRange, MetricOrder, MetricRefund, PricingContext } from "./types";

const DAY_MS = 86_400_000;

interface Windows {
  todayStart: number;
  weekStart: number;
  prevWeekStart: number;
}

function windows(now: Date): Windows {
  return {
    todayStart: istDayStart(istDayKey(now)).getTime(),
    weekStart: now.getTime() - 7 * DAY_MS,
    prevWeekStart: now.getTime() - 14 * DAY_MS,
  };
}

const at = (o: MetricOrder) => new Date(o.createdAt).getTime();

export interface AdminPulse {
  /** Non-cancelled orders since IST midnight — the tile has always meant sales orders. */
  ordersToday: number;
  gmvToday: number;
  orders: { curr: number; prev: number };
  gmv: { curr: number; prev: number };
}

export function adminPulse(orders: MetricOrder[], now: Date): AdminPulse {
  const w = windows(now);
  const sales = salesOrders(orders);
  const today = sales.filter((o) => at(o) >= w.todayStart);
  const curr = sales.filter((o) => at(o) >= w.weekStart);
  const prev = sales.filter((o) => at(o) >= w.prevWeekStart && at(o) < w.weekStart);
  return {
    ordersToday: today.length,
    gmvToday: customerPaid(today),
    orders: { curr: curr.length, prev: prev.length },
    gmv: { curr: customerPaid(curr), prev: customerPaid(prev) },
  };
}

/** Commission + GST on it + other charges, as a settlement would deduct them. */
export function adminEarnings(
  orders: MetricOrder[],
  refunds: MetricRefund[],
  pricing: PricingContext,
  now: Date
): { today: number; curr: number; prev: number } {
  const w = windows(now);
  const within = (from: number, to = Infinity) => orders.filter((o) => at(o) >= from && at(o) < to);
  return {
    today: platformCommission(within(w.todayStart), refunds, pricing).total,
    curr: platformCommission(within(w.weekStart), refunds, pricing).total,
    prev: platformCommission(within(w.prevWeekStart, w.weekStart), refunds, pricing).total,
  };
}

/** One point per IST day: sales orders and what customers paid for them. */
export function adminDailyPoints(
  orders: MetricOrder[],
  range: DateRange
): { date: string; orders: number; gmv: number }[] {
  return dailySeries(orders, range).map((p) => ({ date: p.date, orders: p.orders, gmv: p.sales }));
}
