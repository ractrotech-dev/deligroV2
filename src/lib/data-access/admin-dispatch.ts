import "server-only";
import { listAllOrders } from "@/lib/data-access/admin-orders";
import type { AdminOrderRow } from "@/lib/roles-data";

/**
 * The dashboard's live order board.
 *
 * Lateness is *not* recomputed here. `listAllOrders` already owns that
 * calculation (promise time from the restaurant's eta window plus the accepted
 * / ready stamps added in 0026), and a second implementation on the dashboard
 * is how two screens end up disagreeing about whether an order is late.
 *
 * Service-role, and therefore past RLS: authorized by the `requireRole("admin")`
 * on the page that calls this (AGENTS.md §5).
 */

/** Stages where the order is still moving. */
const IN_FLIGHT = new Set<AdminOrderRow["status"]>([
  "PLACED",
  "KITCHEN",
  "READY",
  "ON_THE_WAY",
]);

/** How deep to look for in-flight work. Beyond this it is a backlog, not a board. */
const SCAN = 120;

export type LiveBoardRow = AdminOrderRow;

export interface LiveBoard {
  rows: LiveBoardRow[];
  /** Every in-flight order, not just the ones shown. */
  inFlight: number;
  /** In-flight and past its promise time. */
  atRisk: number;
}

const EMPTY: LiveBoard = { rows: [], inFlight: 0, atRisk: 0 };

/**
 * The board: in-flight orders, worst-late first.
 *
 * `limit` caps what is rendered, never what is counted: the "3 running late"
 * figure has to be the truth about the whole queue, not about the eight rows
 * that happened to fit.
 */
export async function getLiveBoard(limit = 8): Promise<LiveBoard> {
  let orders: AdminOrderRow[];
  try {
    orders = await listAllOrders(SCAN);
  } catch {
    return EMPTY;
  }

  // listAllOrders already sorts late-first, then newest-first.
  const live = orders.filter((o) => IN_FLIGHT.has(o.status));
  if (!live.length) return EMPTY;

  return {
    rows: live.slice(0, limit),
    inFlight: live.length,
    atRisk: live.filter((o) => (o.lateByMinutes ?? 0) > 0).length,
  };
}
