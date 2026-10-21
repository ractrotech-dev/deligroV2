import "server-only";
import { createClient } from "@/lib/supabase/server";
import { MARKETING_STATUSES } from "@/lib/vendor/growth-input";
import { vendorLedger } from "@/lib/data-access/admin-settlements";
import { listKitchenOrders } from "@/lib/data-access/vendor-orders";
import { loadSaleOrders, SALE_STATUSES } from "@/lib/data-access/vendor-sales";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { summariseLedger, type LedgerSummary } from "@/lib/vendor/money";
import { addIstDays, startOfIstDay, startOfIstMonth } from "@/lib/utils/ist-time";

/**
 * The Partner app's home screen (client requirements §1): every figure the
 * client listed, from the same definitions the payments screen and reports
 * use (lib/vendor/money.ts, lib/settlements/math.ts).
 */
export interface VendorDashboard {
  sales: {
    today: number;
    yesterday: number;
    total: number;
    thisMonth: number;
    lastMonth: number;
  };
  /** Right now, on the board (paid-or-COD, like the kitchen board). */
  live: { new: number; accepted: number; preparing: number; ready: number };
  /** Orders placed today that finished or were cancelled. */
  today: { orders: number; completed: number; cancelled: number };
  /** Null when the shop's Earnings switch is off. */
  money: LedgerSummary | null;
  marketing: {
    available: boolean;
    pending: number;
    approved: number;
    inProgress: number;
    completed: number;
    rejected: number;
  };
  updatedAt: string;
}


export async function getVendorDashboard(
  restaurantId: string,
  opts: { includeMoney: boolean }
): Promise<VendorDashboard> {
  const now = new Date();
  const today = startOfIstDay(now);
  const yesterday = addIstDays(today, -1);
  const month = startOfIstMonth(now);
  const lastMonth = startOfIstMonth(addIstDays(month, -1));

  const [orders, board, ledger, marketing] = await Promise.all([
    loadSaleOrders(restaurantId),
    listKitchenOrders(restaurantId),
    opts.includeMoney ? vendorLedger(restaurantId) : Promise.resolve(null),
    marketingCounts(restaurantId),
  ]);

  const sales = { today: 0, yesterday: 0, total: 0, thisMonth: 0, lastMonth: 0 };
  const todays = { orders: 0, completed: 0, cancelled: 0 };
  const saleStatuses = new Set<string>(SALE_STATUSES);
  for (const o of orders) {
    const at = new Date(o.createdAt);
    const isToday = at >= today;
    if (isToday) {
      todays.orders++;
      if (o.status === "delivered" || o.status === "on_the_way") todays.completed++;
      if (o.status === "cancelled") todays.cancelled++;
    }
    if (!saleStatuses.has(o.status)) continue;
    sales.total += o.sale;
    if (isToday) sales.today += o.sale;
    else if (at >= yesterday) sales.yesterday += o.sale;
    if (at >= month) sales.thisMonth += o.sale;
    else if (at >= lastMonth) sales.lastMonth += o.sale;
  }

  const all = [...board.incoming, ...board.preparing, ...board.ready];
  const live = {
    new: all.filter((o) => o.stage === "new").length,
    accepted: all.filter((o) => o.stage === "accepted").length,
    preparing: all.filter((o) => o.stage === "preparing").length,
    ready: all.filter((o) => o.stage === "ready").length,
  };

  const money = ledger
    ? summariseLedger(ledger.lines, {
        outstandingCorrections: ledger.outstandingCorrections,
        correctedOrderIds: new Set(ledger.correctedOrderIds),
      })
    : null;

  return { sales, live, today: todays, money, marketing, updatedAt: now.toISOString() };
}

/**
 * Marketing requests by status (Phase 6's `marketing_requests`). Until that
 * table exists the dashboard says so (`available: false`) instead of zeros
 * that look like "you have none".
 */
async function marketingCounts(restaurantId: string): Promise<VendorDashboard["marketing"]> {
  const empty = { available: false, pending: 0, approved: 0, inProgress: 0, completed: 0, rejected: 0 };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("status")
    .eq("restaurant_id", restaurantId);
  if (error) {
    if (isMissingTable(error)) return empty;
    throw error;
  }
  const counts = Object.fromEntries(MARKETING_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of data ?? []) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return {
    available: true,
    pending: counts.pending,
    approved: counts.approved,
    inProgress: counts.in_progress,
    completed: counts.completed,
    rejected: counts.rejected,
  };
}
