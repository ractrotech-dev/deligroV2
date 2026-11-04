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
 * Who may cancel is the rule book's: a customer within 20 seconds
 * (customer_cancel_order, 0191), a shop only by rejecting a new order, staff at
 * any time with a written reason (`cancelOrderAsOps` below).
 *
 * `cancelOrderRow` is the shop's rejection and createOrder's own clean-up: one
 * place to record who did it and why, and one place to degrade when the migration
 * has not landed: a cancellation must still succeed on an un-migrated database, it
 * just goes back to being anonymous.
 *
 * What `cancelled_by` is worth is covered in the migration. In short: the
 * trigger derives it from whoever is actually making the write and ignores what
 * a client sends, EXCEPT for service_role — our own server code. So `actor` is
 * meaningful from a service-role writer and is simply redundant from anyone else.
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
 * One audited RPC (ops_cancel_order, 0191) cancels the order and its delivery and
 * writes the audit row, in one transaction. No refund is raised (rule book). After
 * the response, and only when this call did the work (not a replay), the customer,
 * the kitchen and the rider who held or carried it are told.
 */
export async function cancelOrderCore(
  actor: { id: string; role: "admin" | "manager" },
  orderId: string,
  reason: string,
  clientActionId: string
): Promise<
  | { ok: true; replayed: boolean }
  | { ok: false; result: OpsResult }
> {
  const supabase = createAdminClient();

  const { data: delivery } = await supabase
    .from("deliveries").select("status, driver_id, offered_driver_id").eq("order_id", orderId).maybeSingle();

  const { data, error } = await supabase.rpc("ops_cancel_order", {
    p_actor: actor.id, p_order: orderId, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return { ok: false, result: mapRpcError(error) };

  const replayed = (data as { replayed?: boolean } | null)?.replayed === true;

  if (!replayed) {
    const d = delivery as { status: string; driver_id: string | null; offered_driver_id: string | null } | null;
    const carrying = d && (d.status === "assigned" || d.status === "picked_up") ? d.driver_id : null;
    const offered = d?.status === "unassigned" ? d.offered_driver_id : null;
    const riderId = carrying ?? offered;
    if (riderId) {
      deferNotify(() => notifyDriverOrderCancelled(riderId, { orderId, pickedUp: d?.status === "picked_up" }));
    }
    deferNotify(() => notifyOrderCancelled(orderId));
    deferNotify(() => notifyVendorOrderCancelled(orderId, { byAdmin: true }));
  }
  return { ok: true, replayed };
}

export type CancelOpsError =
  | "not_found"
  | "already_cancelled"
  | "delivered"
  | "reason_required"
  | "stale"
  | "write_failed";

export type CancelOpsResult =
  | { ok: true }
  | { ok: false; error: CancelOpsError };

/** A written reason, as staff must give one: at least this many characters. */
export const MIN_CANCEL_REASON = 3;

/**
 * Operations cancelling an order — an admin from the order screen, the
 * Manager app, or a manager or admin approving a failed delivery
 * (`delivery-exceptions.ts`). One implementation: `cancelOrderCore` above,
 * the audited RPC that cancels and stops the delivery in one transaction. The
 * result keeps the Rider branch's shape (`CancelOpsResult`), which its callers
 * switch on.
 *
 * NO AUTHORIZATION HERE beyond the RPC's own zone check: it runs on the
 * service role and trusts `by` and `requestedBy`; every caller has already run
 * `requireRole` / `managerApiContext` for exactly that role (AGENTS.md rules 3
 * and 5). A reason of at least 3 characters is required, here and in the RPC.
 */
export async function cancelOrderAsOps(
  orderId: string,
  opts: { by: "admin" | "manager"; reason: string; requestedBy: string; clientActionId?: string }
): Promise<CancelOpsResult> {
  const reason = normalizeCancellationReason(opts.reason);
  if (!reason || reason.length < MIN_CANCEL_REASON) return { ok: false, error: "reason_required" };
  const result = await cancelOrderCore(
    { id: opts.requestedBy, role: opts.by },
    orderId,
    reason,
    opts.clientActionId ?? crypto.randomUUID()
  );
  if (result.ok) return { ok: true };

  const code = result.result.ok ? "action_failed" : result.result.error;
  const failed = (error: CancelOpsError): CancelOpsResult => ({ ok: false, error });
  if (code === "not_found") return failed("not_found");
  if (code === "stale") return failed("stale");
  if (code === "reason_required") return failed("reason_required");
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
