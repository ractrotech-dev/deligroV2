import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { mapRpcError, type OpsResult } from "@/lib/ops/order-actions";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import {
  notifyDriverOrderCancelled,
  notifyOrderCancelled,
  notifyVendorOrderCancelled,
} from "@/lib/notifications/order-events";
import { deferNotify } from "@/lib/notifications/defer";

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
 * One audited RPC (ops_cancel_order, 0142) cancels the order and its delivery,
 * queues the refund of a paid order (the rest of the total, topping up an open
 * item refund) and writes the audit row, in one transaction — so a cancellation
 * that fails has queued nothing, and one that succeeds never strands money.
 * After the response, and only when this call did the work (not a replay), the
 * customer, the kitchen and the rider who held or carried it are told.
 *
 * On failure `pendingRefund` says whether the order already has an open refund
 * (from an earlier item refund or attempt), so the console can point at it.
 */
export async function cancelOrderCore(
  actor: { id: string; role: "admin" | "manager" },
  orderId: string,
  reason: string,
  clientActionId: string
): Promise<
  | { ok: true; refundQueued: boolean; replayed: boolean }
  | { ok: false; result: OpsResult; refundQueued: false; pendingRefund: boolean }
> {
  const supabase = createAdminClient();

  const { data: delivery } = await supabase
    .from("deliveries").select("status, driver_id, offered_driver_id").eq("order_id", orderId).maybeSingle();

  const { data, error } = await supabase.rpc("ops_cancel_order", {
    p_actor: actor.id, p_order: orderId, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) {
    const { data: open } = await supabase
      .from("refunds").select("id").eq("order_id", orderId).eq("status", "pending").limit(1).maybeSingle();
    return { ok: false, result: mapRpcError(error), refundQueued: false, pendingRefund: !!open };
  }

  const state = (data ?? {}) as { replayed?: boolean; refund_amount?: number | null };
  const replayed = state.replayed === true;
  const refundQueued = Number(state.refund_amount ?? 0) > 0;

  if (!replayed) {
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
  return { ok: true, refundQueued, replayed };
}

export type CancelOpsError =
  | "not_found"
  | "already_cancelled"
  | "delivered"
  | "refund_failed"
  | "stale"
  | "write_failed";

export type CancelOpsResult =
  | { ok: true; refundQueued: boolean }
  | {
      ok: false;
      error: CancelOpsError;
      /** Kept for the rider branch's callers: a failed cancel never queues a refund now. */
      refundQueued?: boolean;
      /** The order already has an open refund (an item refund, or an earlier attempt). */
      pendingRefund?: boolean;
    };

/**
 * Operations cancelling an order — an admin from the order screen, the
 * Manager app, or a manager or admin approving a failed delivery
 * (`delivery-exceptions.ts`). One implementation: `cancelOrderCore` above,
 * the audited RPC that cancels, stops the delivery and queues the refund of a
 * paid order in one transaction (so a cancel that fails has queued nothing).
 * The result keeps the Rider branch's shape (`CancelOpsResult`), which its
 * callers switch on.
 *
 * NO AUTHORIZATION HERE beyond the RPC's own zone check: it runs on the
 * service role and trusts `by` and `requestedBy`; every caller has already run
 * `requireRole` / `managerApiContext` for exactly that role (AGENTS.md rules 3
 * and 5). The RPC requires a reason; none given says who did it.
 */
export async function cancelOrderAsOps(
  orderId: string,
  opts: { by: "admin" | "manager"; reason?: string | null; requestedBy: string; clientActionId?: string }
): Promise<CancelOpsResult> {
  const reason =
    normalizeCancellationReason(opts.reason) ??
    (opts.by === "admin" ? "Cancelled by Deligro support" : "Cancelled by Deligro operations");
  const result = await cancelOrderCore(
    { id: opts.requestedBy, role: opts.by },
    orderId,
    reason,
    opts.clientActionId ?? crypto.randomUUID()
  );
  if (result.ok) return { ok: true, refundQueued: result.refundQueued };

  const code = result.result.ok ? "action_failed" : result.result.error;
  // A failed cancel never queues a refund now (the RPC is one transaction), so
  // `refundQueued` is not reported; an open refund the order already carries is.
  const failed = (error: CancelOpsError): CancelOpsResult =>
    result.pendingRefund ? { ok: false, error, pendingRefund: true } : { ok: false, error };
  if (code === "not_found") return failed("not_found");
  if (code === "stale") return failed("stale");
  if (code === "terminal") {
    // Finished one way or the other: say which, the callers answer differently.
    const { data } = await createAdminClient().from("orders").select("status").eq("id", orderId).maybeSingle();
    const status = (data as { status: string } | null)?.status;
    if (status === "cancelled") return failed("already_cancelled");
    if (status === "delivered") return failed("delivered");
    return failed("stale");
  }
  return failed("write_failed");
}
