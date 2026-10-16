import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAllOrders } from "@/lib/data-access/admin-orders";
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

/**
 * How long an order may sit without a rider before it counts as a dispatch
 * failure. Matches the reassignment window the settings screen describes.
 */
export const UNASSIGNED_AFTER_MIN = 8;

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
  const riders = await ridersByOrder(ids);

  const atRisk = live.filter((o) => (o.lateByMinutes ?? 0) > 0).length;

  // "No rider yet" is only a problem once the order has had time to be picked
  // up; every order is unassigned for its first few seconds.
  const cutoff = Date.now() - UNASSIGNED_AFTER_MIN * 60_000;
  const unassigned = live.filter((o) => {
    if (!o.id || riders.get(o.id)) return false;
    const placed = placedMs(o);
    return placed === null ? false : placed < cutoff;
  }).length;

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

/**
 * order id → rider name, for the orders given. Two queries rather than an
 * embed: `deliveries.driver_id` points at `profiles`, and the rest of this
 * codebase resolves that pair by hand (see getOrderDelivery) because the
 * relationship has no name PostgREST can be relied on to expose.
 *
 * A failure here costs the rider column, not the board.
 */
async function ridersByOrder(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;

  try {
    const supabase = createAdminClient();

    const { data: deliveries, error } = await supabase
      .from("deliveries")
      .select("order_id, driver_id")
      .in("order_id", ids);
    if (error || !deliveries?.length) return out;

    const rows = deliveries as { order_id: string; driver_id: string | null }[];
    const driverIds = [
      ...new Set(rows.map((r) => r.driver_id).filter((d): d is string => Boolean(d))),
    ];
    if (!driverIds.length) return out;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", driverIds);

    const nameById = new Map(
      ((profiles ?? []) as { id: string; full_name: string | null }[]).map((p) => [
        p.id,
        p.full_name?.trim() || "Rider",
      ])
    );

    for (const r of rows) {
      const name = r.driver_id ? nameById.get(r.driver_id) : undefined;
      if (name) out.set(r.order_id, name);
    }
  } catch {
    // Fall through with whatever was resolved.
  }

  return out;
}

/**
 * When the order was placed, in ms.
 *
 * Reads `placedAtIso`, never `placedAt` — the latter is a localised display
 * string ("24 Jul, 8:24 PM") and parsing it back is guesswork. An order whose
 * age cannot be established is excluded from the unassigned count rather than
 * assumed to be old: over-reporting a dispatch failure sends an operator
 * chasing an order that is fine.
 */
function placedMs(order: AdminOrderRow): number | null {
  if (!order.placedAtIso) return null;
  const parsed = Date.parse(order.placedAtIso);
  return Number.isNaN(parsed) ? null : parsed;
}
