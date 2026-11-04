import "server-only";
import { listAllOrders, ridersByOrder, unassignedOrderIds } from "@/lib/data-access/admin-orders";
import { UNASSIGNED_AFTER_MIN } from "@/lib/dispatch/thresholds";
import type { AdminOrderRow } from "@/lib/roles-data";

/**
 * The dashboard's live order board, and the dispatch queue behind it.
 *
 * Lateness is *not* recomputed here. `listAllOrders` already owns that
 * calculation (promise time from the restaurant's eta window plus the accepted
 * / ready stamps added in 0026), and a second implementation on the dashboard
 * is how two screens end up disagreeing about whether an order is late. This
 * module takes that feed and answers the two things the board adds: who is
 * carrying the order, and how many have nobody carrying them.
 *
 * Service-role, and therefore past RLS: authorized by the /admin layout's
 * `requireRole("admin")`, which runs before any caller renders (AGENTS.md §5).
 */

/** Stages where the order is still moving and a rider is relevant. */
const IN_FLIGHT = new Set<AdminOrderRow["status"]>([
  "PLACED",
  "KITCHEN",
  "READY",
  "ON_THE_WAY",
]);

export { UNASSIGNED_AFTER_MIN };

/** How deep to look for in-flight work. Beyond this it is a backlog, not a board. */
const SCAN = 120;

export interface LiveBoardRow extends AdminOrderRow {
  /** Null when nobody is assigned yet — rendered as "Unassigned", not blank. */
  rider: string | null;
}

export interface LiveBoard {
  rows: LiveBoardRow[];
  /** Every in-flight order, not just the ones shown. */
  inFlight: number;
  /** In-flight and past its promise time. */
  atRisk: number;
  /** In-flight, older than UNASSIGNED_AFTER_MIN, still with no rider. */
  unassigned: number;
}

const EMPTY: LiveBoard = { rows: [], inFlight: 0, atRisk: 0, unassigned: 0 };

/**
 * The board: in-flight orders, worst-late first, with the rider carrying each.
 *
 * `limit` caps what is rendered, never what is counted — the "3 at risk" figure
 * has to be the truth about the whole queue, not about the eight rows that
 * happened to fit.
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

  const ids = live.map((o) => o.id).filter((id): id is string => Boolean(id));
  const [riders, unassignedIds] = await Promise.all([
    ridersByOrder(ids),
    // The same list "Orders with no rider" opens. Its failure costs this card.
    unassignedOrderIds().catch(() => [] as string[]),
  ]);

  const atRisk = live.filter((o) => (o.lateByMinutes ?? 0) > 0).length;
  const unassigned = unassignedIds.length;

  return {
    rows: live.slice(0, limit).map((o) => ({
      ...o,
      rider: (o.id && riders.get(o.id)) || null,
    })),
    inFlight: live.length,
    atRisk,
    unassigned,
  };
}
