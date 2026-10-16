import { createClient } from "@/lib/supabase/server";
import { adminOrderStatus } from "@/lib/data-access/admin-orders";
import type { AdminOrderRow } from "@/lib/roles-data";
import { shortOrderId } from "@/lib/utils/order-map";
import { formatDateTime } from "@/lib/utils/relative-time";
import type { PaymentMethod, PaymentStatus } from "@/types";
import { columnKnownMissing, isMissingColumn, rememberColumn } from "./schema-probe";

/**
 * The manager's operational view of the order pipeline.
 *
 * Every read and write in this file goes through the RLS client — the manager's
 * own JWT — not `createAdminClient()`. Migration 0023 grants a manager exactly
 * what they need here (read all orders, update orders, read profiles and
 * order_items, full management of `deliveries`) and deliberately withholds the
 * rest. Routing these queries through the service role would work, and would
 * quietly convert every limit 0023 imposes on purpose into no limit at all.
 */

/** The stages a manager works: everything still in flight. */
const ACTIVE = ["placed", "kitchen", "ready", "on_the_way"] as const;

const PAYMENT_COLUMNS = "orders.payment_method";
/** Provenance, added by 0029. Shared probe key with manager-phone-orders.ts. */
const CHANNEL_COLUMN = "orders.channel";

export interface ManagerOrderRow {
  id: string;
  code: string;
  customer: string;
  customerPhone: string | null;
  restaurant: string;
  status: AdminOrderRow["status"];
  dbStatus: string;
  total: number;
  placedAt: string;
  createdAtIso: string;
  itemCount: number;
  /** Undefined when the column is absent — not "cash". See slice A/D. */
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  /**
   * True when a manager typed this order on a call (0029). Worth a badge on the
   * board: nobody at the other end confirmed a total, an address or an ETA, so
   * an address that looks wrong probably is, and the customer cannot be assumed
   * to be watching the tracker.
   */
  byPhone?: boolean;
  /** The rider carrying it, when one has been assigned. */
  rider: { id: string; name: string; phone: string | null } | null;
  deliveryStatus: string | null;
}

interface OrderRow {
  id: string;
  status: string;
  total: number | null;
  created_at: string;
  payment_method?: PaymentMethod | null;
  payment_status?: PaymentStatus | null;
  channel?: string | null;
  order_items: { id: string }[] | null;
  restaurants: { name: string | null } | { name: string | null }[] | null;
  customer:
    | { full_name: string | null; phone: string | null }
    | { full_name: string | null; phone: string | null }[]
    | null;
}

interface DeliveryJoin {
  order_id: string;
  status: string | null;
  driver_id: string | null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Which optional migrations this database is believed to have. Each group is
 * dropped independently, so an environment missing one still gets the other.
 */
interface SelectFlags {
  /** `payment_method` / `payment_status` — migration 0025. */
  payment: boolean;
  /** `channel` — migration 0029. */
  channel: boolean;
}

function columns(flags: SelectFlags): string {
  return [
    "id, status, total, created_at",
    flags.payment ? ", payment_method, payment_status" : "",
    flags.channel ? ", channel" : "",
    ", order_items(id)",
    ", restaurants(name)",
    ", customer:profiles!orders_customer_id_fkey(full_name, phone)",
  ].join("");
}

/**
 * Newest migration first. `isMissingColumn` doesn't say WHICH column PostgREST
 * rejected, so the only sound order is to drop the most recently added group
 * and re-probe. Same shape as `selectOrders()` in data-access/orders.ts, which
 * solves the same problem for the customer-facing query.
 */
const OPTIONAL_GROUPS: Array<{ key: keyof SelectFlags; column: string }> = [
  { key: "channel", column: CHANNEL_COLUMN },
  { key: "payment", column: PAYMENT_COLUMNS },
];

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
}

/**
 * Run the query, narrowing the column list until the database accepts it, and
 * remember the answer so the retry cost is paid once per process.
 *
 * At most one attempt per still-optimistic group, plus the final bare one.
 */
async function probeSelect<T>(
  run: (select: string) => PromiseLike<QueryResult<T>>,
  flags: SelectFlags
): Promise<T | null> {
  for (const { key, column } of OPTIONAL_GROUPS) {
    if (!flags[key]) continue;

    const { data, error } = await run(columns(flags));
    if (!error) {
      for (const g of OPTIONAL_GROUPS) if (flags[g.key]) rememberColumn(g.column, true);
      return data;
    }
    if (!isMissingColumn(error)) throw error;

    rememberColumn(column, false);
    flags[key] = false;
  }

  const { data, error } = await run(columns(flags));
  if (error) throw error;
  return data;
}

/**
 * Every order still in flight, across every restaurant, oldest first.
 *
 * Oldest-first is the opposite of the admin feed and is deliberate: this is a
 * work queue, not a news feed. The order that has been waiting longest is the
 * one that needs a decision, and on a phone screen it has to be the one in
 * reach rather than the one pushed off the bottom.
 */
export async function listActiveOrders(): Promise<ManagerOrderRow[]> {
  const supabase = await createClient();

  const run = (select: string) =>
    supabase
      .from("orders")
      .select(select)
      .in("status", ACTIVE)
      .order("created_at", { ascending: true })
      .overrideTypes<Record<string, unknown>[]>();

  // A missing group costs the board a badge, never a row: without 0025 it
  // cannot say how anything was paid (and says nothing rather than guessing
  // "cash"); without 0029 it cannot mark phone orders. Both still list.
  const flags: SelectFlags = {
    payment: !columnKnownMissing(PAYMENT_COLUMNS),
    channel: !columnKnownMissing(CHANNEL_COLUMN),
  };

  const rows = ((await probeSelect(run, flags)) ?? []) as unknown as OrderRow[];
  if (rows.length === 0) return [];

  // One query for the delivery legs rather than one per order.
  const { data: legs } = await supabase
    .from("deliveries")
    .select("order_id, status, driver_id")
    .in(
      "order_id",
      rows.map((r) => r.id)
    );

  const deliveries = new Map<string, DeliveryJoin>();
  for (const d of (legs ?? []) as DeliveryJoin[]) deliveries.set(d.order_id, d);

  // And one for the riders named by those legs.
  const driverIds = [
    ...new Set(
      [...deliveries.values()].map((d) => d.driver_id).filter((v): v is string => Boolean(v))
    ),
  ];
  const riders = new Map<string, { full_name: string | null; phone: string | null }>();
  if (driverIds.length > 0) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", driverIds);
    for (const p of (people ?? []) as {
      id: string;
      full_name: string | null;
      phone: string | null;
    }[]) {
      riders.set(p.id, p);
    }
  }

  return rows.map((r) => {
    const leg = deliveries.get(r.id) ?? null;
    const rider = leg?.driver_id ? riders.get(leg.driver_id) : null;
    const customer = one(r.customer);

    return {
      id: r.id,
      code: `#${shortOrderId(r.id)}`,
      customer: customer?.full_name?.trim() || "Customer",
      customerPhone: customer?.phone?.trim() || null,
      restaurant: one(r.restaurants)?.name ?? "—",
      status: adminOrderStatus(r.status),
      dbStatus: r.status,
      total: Number(r.total ?? 0),
      placedAt: formatDateTime(r.created_at),
      createdAtIso: r.created_at,
      itemCount: r.order_items?.length ?? 0,
      paymentMethod: r.payment_method ?? undefined,
      paymentStatus: r.payment_status ?? undefined,
      // Undefined, not false, when 0029 is absent: "we don't know" and "placed
      // in the app" are different claims, and the badge should stay off rather
      // than assert the second one.
      byPhone: r.channel === undefined ? undefined : r.channel === "phone",
      rider:
        leg?.driver_id && rider
          ? {
              id: leg.driver_id,
              name: rider.full_name?.trim() || "Rider",
              phone: rider.phone?.trim() || null,
            }
          : null,
      deliveryStatus: leg?.status ?? null,
    };
  });
}

export interface ManagerRider {
  id: string;
  name: string;
  phone: string | null;
  /** How many deliveries they are already carrying — dispatch needs this. */
  activeJobs: number;
}

/**
 * The riders a manager can dispatch to, least-loaded first.
 *
 * The load count is the point: assigning by name alone is how one rider ends up
 * with four jobs while another has none. `assigned` and `picked_up` are both
 * live work; `delivered` is finished and does not count against them.
 */
export async function listRiders(): Promise<ManagerRider[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, phone")
    .eq("role", "driver");

  if (error) throw error;

  const riders = (data ?? []) as {
    id: string;
    full_name: string | null;
    phone: string | null;
  }[];
  if (riders.length === 0) return [];

  const { data: legs } = await supabase
    .from("deliveries")
    .select("driver_id")
    .in("status", ["assigned", "picked_up"]);

  const load = new Map<string, number>();
  for (const l of (legs ?? []) as { driver_id: string | null }[]) {
    if (l.driver_id) load.set(l.driver_id, (load.get(l.driver_id) ?? 0) + 1);
  }

  return riders
    .map((r) => ({
      id: r.id,
      name: r.full_name?.trim() || "Rider",
      phone: r.phone?.trim() || null,
      activeJobs: load.get(r.id) ?? 0,
    }))
    .sort((a, b) => a.activeJobs - b.activeJobs || a.name.localeCompare(b.name));
}
