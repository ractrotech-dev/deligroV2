import "server-only";
import { listAllOrders, unassignedOrderIds } from "@/lib/data-access/admin-orders";
import { listActiveOrders, type ManagerOrderRow } from "@/lib/data-access/manager-orders";
import { UNASSIGNED_AFTER_MIN } from "@/lib/dispatch/thresholds";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DbOrderStatus } from "@/lib/ops/order-contract";
import type { AdminOrderRow } from "@/lib/roles-data";

/**
 * The admin dashboard's order desk: every order still moving, with what the
 * operator needs to act on it.
 *
 * Nothing here is computed twice. Lateness and the dish list come from
 * `listAllOrders`, which owns the promise-time calculation; the people on the
 * order come from `listActiveOrders`, the manager board's read; and "no rider"
 * comes from `unassignedOrderIds`, the same list the Orders screen filters on.
 *
 * Service role in part, so past RLS: authorized by the page's `requireRole("admin")`
 * (AGENTS.md rule 5). Phone numbers are on these rows, so they must not be handed to
 * anyone else.
 */

/** Stages where the order is still moving. */
const IN_FLIGHT = new Set<AdminOrderRow["status"]>(["PLACED", "KITCHEN", "READY", "ON_THE_WAY"]);

/** How deep to look for recent orders; every in-flight one is read regardless. */
const SCAN = 120;

export { UNASSIGNED_AFTER_MIN };

export interface DeskOrder {
  id: string;
  code: string;
  status: AdminOrderRow["status"];
  dbStatus: DbOrderStatus;
  restaurant: string;
  shopPhone: string | null;
  customer: string;
  customerPhone: string | null;
  total: number;
  placedAtIso: string;
  paymentMethod?: AdminOrderRow["paymentMethod"];
  paymentStatus?: AdminOrderRow["paymentStatus"];
  lateByMinutes: number;
  items: { name: string; qty: number }[];
  byPhone: boolean;
  rider: ManagerOrderRow["rider"];
  deliveryStatus: string | null;
  /** In flight past UNASSIGNED_AFTER_MIN with nobody carrying it. */
  noRider: boolean;
}

export interface OrderDesk {
  orders: DeskOrder[];
  atRisk: number;
  unassigned: number;
  /**
   * The orders could not be read. The screen says so: an empty board means
   * "nothing is moving", and an operator acts on that.
   */
  failed: boolean;
}

/**
 * The shop's number for each order. The public line first, then the owner's.
 * `owner_mobile` is why this is the service role: it is revoked from
 * `authenticated` (0022). A failure costs the Call shop link, not the board.
 */
async function shopPhonesByOrder(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const { data } = await createAdminClient()
      .from("orders")
      .select("id, restaurants(shop_phone, owner_mobile)")
      .in("id", ids)
      .overrideTypes<
        {
          id: string;
          restaurants:
            | { shop_phone: string | null; owner_mobile: string | null }
            | { shop_phone: string | null; owner_mobile: string | null }[]
            | null;
        }[]
      >();
    for (const row of data ?? []) {
      const shop = Array.isArray(row.restaurants) ? row.restaurants[0] : row.restaurants;
      const phone = shop?.shop_phone?.trim() || shop?.owner_mobile?.trim();
      if (phone) out.set(row.id, phone);
    }
  } catch {
    // Fall through with whatever was resolved.
  }
  return out;
}

const EMPTY: OrderDesk = { orders: [], atRisk: 0, unassigned: 0, failed: false };

/** Worst-late first, then whichever has waited longest. */
function byUrgency(a: DeskOrder, b: DeskOrder): number {
  return b.lateByMinutes - a.lateByMinutes || a.placedAtIso.localeCompare(b.placedAtIso);
}

export async function getOrderDesk(): Promise<OrderDesk> {
  let feed: AdminOrderRow[];
  let active: ManagerOrderRow[];
  try {
    [feed, active] = await Promise.all([listAllOrders(SCAN), listActiveOrders()]);
  } catch {
    return { ...EMPTY, failed: true };
  }

  const live = new Map(active.map((o) => [o.id, o]));
  const rows = feed.filter((o) => o.id && IN_FLIGHT.has(o.status) && live.has(o.id));
  if (!rows.length) return EMPTY;

  const ids = rows.map((o) => o.id as string);
  const [unassignedIds, shopPhones] = await Promise.all([
    // Its failure costs the No rider flag, not the board.
    unassignedOrderIds().catch(() => [] as string[]),
    shopPhonesByOrder(ids),
  ]);
  const noRider = new Set(unassignedIds);

  const orders = rows
    .map((o): DeskOrder => {
      const id = o.id as string;
      const m = live.get(id) as ManagerOrderRow;
      return {
        id,
        code: o.code,
        status: o.status,
        dbStatus: m.dbStatus as DbOrderStatus,
        restaurant: o.restaurant,
        shopPhone: shopPhones.get(id) ?? null,
        customer: o.customer,
        customerPhone: m.customerPhone,
        total: o.total,
        placedAtIso: m.createdAtIso,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        lateByMinutes: o.lateByMinutes ?? 0,
        items: o.items ?? [],
        byPhone: m.byPhone === true,
        rider: m.rider,
        deliveryStatus: m.deliveryStatus,
        noRider: noRider.has(id),
      };
    })
    .sort(byUrgency);

  return {
    orders,
    atRisk: orders.filter((o) => o.lateByMinutes > 0).length,
    unassigned: orders.filter((o) => o.noRider).length,
    failed: false,
  };
}
