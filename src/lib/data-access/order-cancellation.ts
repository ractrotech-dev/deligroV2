import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { queueRefundForOrder } from "@/lib/data-access/refunds";
import { cancelDeliveryForOrder } from "@/lib/dispatch/rider-dispatch";
import {
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

export type CancelOpsError =
  | "not_found"
  | "already_cancelled"
  | "delivered"
  | "refund_failed"
  | "stale"
  | "write_failed";

export type CancelOpsResult =
  | { ok: true; refundQueued: boolean }
  | { ok: false; error: CancelOpsError; refundQueued?: boolean };

/**
 * Operations cancelling an order on the customer's behalf — an admin from the
 * order screen, or a manager or admin approving a failed delivery
 * (`delivery-exceptions.ts`). The one implementation: `cancelOrderAsAdmin`
 * calls this after its own role check.
 *
 * NO AUTHORIZATION HERE. It runs on the service role and trusts `by` and
 * `requestedBy`; every caller has already run `requireRole` for exactly that
 * role (AGENTS.md rules 3 and 5). It is a data-layer function, not an action.
 *
 * The refund is the point. Before slice B nothing in the app had ever written
 * to `refunds`, so an operator cancelling a paid order took the food away and
 * left the money where it was. `queueRefundForOrder` is idempotent and returns
 * `queued: false` when the order was never paid, so a COD cancel correctly
 * queues nothing rather than inventing a refund to hand back.
 *
 * Refund first, then cancel: if the status write fails we would rather have an
 * open refund on a live order (visible in /admin/refunds, resolvable by a human)
 * than a cancelled order with no money attached to it. `refundQueued` on a
 * failure says that happened.
 *
 * Then: any delivery still in progress is stopped (`cancelDeliveryForOrder`; a
 * delivery an approved exception already failed is left as it is), and the
 * customer and the kitchen are told. Revalidating screens is the caller's.
 */
export async function cancelOrderAsOps(
  orderId: string,
  opts: { by: "admin" | "manager"; reason?: string | null; requestedBy: string }
): Promise<CancelOpsResult> {
  const supabase = createAdminClient();
  const { data: current, error: readError } = await supabase
    .from("orders")
    .select("id, status, restaurant_id")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; status: string; restaurant_id: string | null }>();
  if (readError) throw readError;
  if (!current) return { ok: false, error: "not_found" };
  if (current.status === "cancelled") return { ok: false, error: "already_cancelled" };
  // Cancelling after the food arrived is not a cancellation, it is a refund.
  // /admin/refunds is where that is decided, with the amount in view.
  if (current.status === "delivered") return { ok: false, error: "delivered" };

  const reason = normalizeCancellationReason(opts.reason);

  let refundQueued = false;
  try {
    const refund = await queueRefundForOrder(orderId, {
      // Ops raised it, whichever ops role; requested_by names the person.
      origin: "admin",
      reason,
      requestedBy: opts.requestedBy,
    });
    refundQueued = refund.queued;
  } catch {
    return { ok: false, error: "refund_failed" };
  }

  // Conditional on the status just read: an order delivered in the seconds
  // since is not cancelled over the top of a delivery that happened. The reason
  // goes on the order too, which is the row the customer's screen reads.
  const { data: cancelled, error } = await cancelOrderRow(
    (patch) =>
      supabase
        .from("orders")
        .update(patch)
        .eq("id", orderId)
        .eq("status", current.status)
        .select("id")
        .overrideTypes<{ id: string }[]>(),
    { actor: opts.by, reason }
  );
  if (error) return { ok: false, error: "write_failed", refundQueued };
  if (!cancelled || cancelled.length === 0) return { ok: false, error: "stale", refundQueued };

  // A rider may already have accepted this order. Stop them completing a
  // delivery for an order ops just cancelled — see the function's own comment
  // for why an accepted delivery is cancelled rather than deleted.
  await cancelDeliveryForOrder(orderId);

  deferNotify(() => notifyOrderCancelled(orderId, { refundQueued }));
  // The kitchen may already be cooking this. Telling them is not optional.
  if (current.restaurant_id) {
    deferNotify(() => notifyVendorOrderCancelled(orderId, { byAdmin: true }));
  }
  return { ok: true, refundQueued };
}
