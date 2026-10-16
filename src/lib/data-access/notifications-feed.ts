import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/**
 * What has actually happened to this customer's orders, as a feed.
 *
 * The bell in the header pointed at a settings screen — two rows of text and a
 * permission switch — because there was nothing else for it to point at. Push
 * notifications are sent through OneSignal and nothing about them is stored: no
 * table, no history, no read state. A customer who missed the "your rider is on
 * the way" banner had no way to see it again.
 *
 * This does not invent that table. The events a customer was pushed about are
 * the same events the order lifecycle already timestamps — `created_at` when
 * they ordered, `accepted_at` when the kitchen took it, `ready_at` when it was
 * packed, `cancelled_at` when it stopped (all `orders`, migration 0026) — so the
 * feed is derived from facts the database already holds rather than from a log
 * nobody is writing. It is therefore honest by construction: nothing can appear
 * here that did not happen, and nothing can go missing because a push failed.
 *
 * The cost of deriving rather than logging: no read state, and no entry for a
 * notification that was not a lifecycle change. Both are worth it until there
 * is a reason to write rows.
 */

/** `accepted_at` / `ready_at` arrive in 0026. */
const LIFECYCLE_COLUMNS = "orders.accepted_at";
/** `cancelled_by` / `cancellation_reason` arrive in 0051. */
const CANCELLATION_COLUMNS = "orders.cancelled_by";

export type ActivityKind =
  "placed" | "accepted" | "ready" | "on_the_way" | "delivered" | "cancelled";

export interface ActivityEvent {
  /** Stable per event, so React keys and read-state can key on it later. */
  id: string;
  orderId: string;
  kind: ActivityKind;
  at: string;
  restaurantName: string;
  /** Rendered under the title — the reason, for a cancellation. */
  detail?: string;
}

interface Row {
  id: string;
  status: string;
  created_at: string;
  accepted_at?: string | null;
  ready_at?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  restaurants: { name: string } | { name: string }[] | null;
}

function shopName(row: Row): string {
  const r = Array.isArray(row.restaurants)
    ? row.restaurants[0]
    : row.restaurants;
  return r?.name ?? "your order";
}

/** The query succeeded, so every group still switched on is really there. */
function rememberPresent<K extends string>(
  groups: { key: K; column: string }[],
  flags: Record<K, boolean>
): void {
  for (const g of groups) if (flags[g.key]) rememberColumn(g.column, true);
}

/**
 * Read the columns, dropping the optional groups on a database that predates
 * them — the same probe-and-degrade shape `selectOrders` uses, for the same
 * reason: a missing migration should cost this screen some detail, not take the
 * whole feed down.
 */
async function fetchRows(limit: number): Promise<Row[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const flags = {
    lifecycle: !columnKnownMissing(LIFECYCLE_COLUMNS),
    cancellation: !columnKnownMissing(CANCELLATION_COLUMNS),
  };

  const select = () =>
    [
      "id, status, created_at",
      flags.lifecycle ? ", accepted_at, ready_at, cancelled_at" : "",
      flags.cancellation ? ", cancellation_reason" : "",
      ", restaurants(name)",
    ].join("");

  const groups: { key: keyof typeof flags; column: string }[] = [
    { key: "cancellation", column: CANCELLATION_COLUMNS },
    { key: "lifecycle", column: LIFECYCLE_COLUMNS },
  ];

  for (const { key, column } of groups) {
    if (!flags[key]) continue;
    const { data, error } = await supabase
      .from("orders")
      .select(select())
      .eq("customer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!error) {
      rememberPresent(groups, flags);
      return (data ?? []) as unknown as Row[];
    }
    if (!isMissingColumn(error)) throw error;
    rememberColumn(column, false);
    flags[key] = false;
  }

  const { data, error } = await supabase
    .from("orders")
    .select(select())
    .eq("customer_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

/**
 * The feed, newest first.
 *
 * `orders` is read ahead of `limit` events because one order yields up to four
 * of them — a delivered order placed, accepted, packed and handed over is four
 * lines in the list, not one.
 */
export async function listActivity(limit = 40): Promise<ActivityEvent[]> {
  const rows = await fetchRows(Math.max(10, Math.ceil(limit / 2)));
  const out: ActivityEvent[] = [];

  for (const row of rows) {
    const name = shopName(row);
    const push = (
      kind: ActivityKind,
      at: string | null | undefined,
      detail?: string
    ) => {
      if (!at) return;
      out.push({
        id: `${row.id}:${kind}`,
        orderId: row.id,
        kind,
        at,
        restaurantName: name,
        detail,
      });
    };

    push("placed", row.created_at);
    push("accepted", row.accepted_at);
    push("ready", row.ready_at);
    push(
      "cancelled",
      row.cancelled_at,
      row.cancellation_reason?.trim() || undefined
    );

    /*
     * `on_the_way` and `delivered` have no column of their own on `orders` —
     * the first lives on `deliveries.picked_up_at` and the second is only a
     * status. Rather than join a second table for a timestamp this screen can
     * live without, a terminal order contributes one entry stamped with the
     * last time we know of. It is the right event with an approximate clock,
     * which beats omitting the delivery entirely from a delivery app's feed.
     */
    if (row.status === "delivered") {
      push("delivered", row.ready_at ?? row.accepted_at ?? row.created_at);
    } else if (row.status === "on_the_way") {
      push("on_the_way", row.ready_at ?? row.accepted_at ?? row.created_at);
    }
  }

  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}
