import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueRefundForOrder } from "@/lib/data-access/refunds";
import { deferNotify } from "@/lib/notifications/defer";
import {
  notifyDriverOrderCancelled,
  notifyOrderCancelled,
  notifyVendorOrderCancelled,
} from "@/lib/notifications/order-events";
import { mapRpcError, type OpsResult } from "@/lib/ops/order-actions";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/**
 * Writing a cancellation, on a database that may not have 0051 yet.
 *
 * Three paths cancel an order — the customer's route, the kitchen board and the
 * admin console — and all three now have something to say about who did it and
 * why. One place to say it, so the three cannot drift into recording the same
 * event three different ways, and one place to degrade when the migration has
 * not landed: a cancellation must still succeed on an un-migrated database, it
 * just goes back to being anonymous.
 *
 * What `cancelled_by` is worth is covered in the migration. In short: the
 * trigger derives it from whoever is actually making the write and ignores what
 * a client sends, EXCEPT for service_role — our own server code — which is the
 * only caller that can know a customer-initiated cancel arrived through an
 * admin client. So `actor` is meaningful from a service-role writer and is
 * simply redundant from anyone else.
 */
const CANCELLATION_COLUMNS = "orders.cancelled_by";

export type CancelActor =
  "customer" | "vendor" | "manager" | "admin" | "system";

/** Matches `orders_cancellation_reason_check` — the column's own bound. */
const MAX_CANCELLATION_REASON = 200;

/**
 * A reason fit to store, or undefined.
 *
 * Trimmed and truncated rather than rejected: this is the last step of an
 * action the operator has already committed to, and failing a cancellation
 * because somebody pasted 300 characters would be the wrong thing to protect.
 */
export function normalizeCancellationReason(
  raw: string | null | undefined
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_CANCELLATION_REASON);
}

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
}

/**
 * Run a cancelling update, retrying without the 0051 columns if this database
 * does not have them.
 *
 * `run` is handed the patch and builds the rest of the statement itself —
 * every caller has its own optimistic `.eq("status", …)` lock and its own
 * client, and those are not this function's business. The retry is safe
 * precisely because of that lock: a statement rejected for an unknown column
 * changed nothing, so the second attempt is still racing against the same row
 * state it was written against.
 */
export async function cancelOrderRow<T>(
  run: (patch: Record<string, unknown>) => PromiseLike<QueryResult<T>>,
  options: { actor?: CancelActor; reason?: string | null } = {}
): Promise<QueryResult<T>> {
  const bare = { status: "cancelled" as const };

  const reason = normalizeCancellationReason(options.reason);
  if (columnKnownMissing(CANCELLATION_COLUMNS) || (!options.actor && !reason)) {
    return run(bare);
  }

  const patch: Record<string, unknown> = { ...bare };
  if (options.actor) patch.cancelled_by = options.actor;
  if (reason) patch.cancellation_reason = reason;

  const first = await run(patch);
  if (!first.error) {
    rememberColumn(CANCELLATION_COLUMNS, true);
    return first;
  }
  if (!isMissingColumn(first.error)) return first;

  rememberColumn(CANCELLATION_COLUMNS, false);
  return run(bare);
}

/**
 * Cancel an order on behalf of operations (an admin or a manager), with a
 * reason — the one path the admin console, the manager app and (from the Rider
 * branch) an approved failed-delivery exception all take.
 *
 * Order of operations, as cancelOrderAsAdmin always had it: queue the refund
 * of a paid order FIRST, so a cancellation never strands money; then the
 * audited RPC (ops_cancel_order, 0142), which cancels the order and its
 * delivery and writes the audit row in one transaction; then, after the
 * response, tell the customer, the kitchen and the rider who held or carried it.
 */
export async function cancelOrderCore(
  actor: { id: string; role: "admin" | "manager" },
  orderId: string,
  reason: string,
  clientActionId: string
): Promise<{ ok: true; refundQueued: boolean } | { ok: false; result: OpsResult; refundQueued: boolean }> {
  const supabase = createAdminClient();

  const { data: logged } = await supabase
    .from("ops_audit_log").select("actor_id").eq("client_action_id", clientActionId).maybeSingle();
  const replay = !!logged && (logged as { actor_id: string }).actor_id === actor.id;

  const [{ data: order }, { data: delivery }] = await Promise.all([
    supabase.from("orders").select("status").eq("id", orderId).maybeSingle(),
    supabase.from("deliveries").select("status, driver_id, offered_driver_id").eq("order_id", orderId).maybeSingle(),
  ]);
  const status = (order as { status: string } | null)?.status;
  if (!status) return { ok: false, result: { ok: false, status: 404, error: "not_found" }, refundQueued: false };

  let refundQueued = false;
  if (!replay) {
    if (status === "delivered" || status === "cancelled") {
      return { ok: false, result: { ok: false, status: 409, error: "terminal" }, refundQueued: false };
    }
    try {
      const refund = await queueRefundForOrder(orderId, {
        origin: actor.role,
        reason: normalizeCancellationReason(reason),
        requestedBy: actor.id,
      });
      refundQueued = refund.queued;
    } catch {
      return { ok: false, result: { ok: false, status: 500, error: "action_failed" }, refundQueued: false };
    }
  }

  const { error } = await supabase.rpc("ops_cancel_order", {
    p_actor: actor.id, p_order: orderId, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return { ok: false, result: mapRpcError(error), refundQueued };

  if (!replay) {
    const d = delivery as { status: string; driver_id: string | null; offered_driver_id: string | null } | null;
    const carrying = d && (d.status === "assigned" || d.status === "picked_up") ? d.driver_id : null;
    const offered = d?.status === "unassigned" ? d.offered_driver_id : null;
    const riderId = carrying ?? offered;
    if (riderId) {
      deferNotify(() => notifyDriverOrderCancelled(riderId, { orderId, pickedUp: d?.status === "picked_up" }));
    }
    deferNotify(() => notifyOrderCancelled(orderId, { refundQueued }));
    deferNotify(() => notifyVendorOrderCancelled(orderId, { byAdmin: true }));
  }
  return { ok: true, refundQueued };
}

/**
 * The Rider plan's entry point (rider phase 2, Task 4), kept to its exact
 * signature so the branches converge: cancel as ops with a reason.
 */
export async function cancelOrderAsOps(
  orderId: string,
  opts: { by: "admin" | "manager"; reason: string; requestedBy: string }
): Promise<{ ok: true; refundQueued: boolean } | { ok: false; error: string }> {
  const result = await cancelOrderCore(
    { id: opts.requestedBy, role: opts.by },
    orderId,
    opts.reason,
    crypto.randomUUID()
  );
  return result.ok ? result : { ok: false, error: result.result.ok ? "action_failed" : result.result.error };
}
