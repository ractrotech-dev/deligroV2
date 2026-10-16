import "server-only";
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
