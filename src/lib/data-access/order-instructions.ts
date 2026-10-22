import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { foldIntoAddressLine, normalizeInstructions } from "@/lib/orders/instructions";
import { isMissingColumnOnWrite, writeWithColumnFallback } from "@/lib/data-access/column-fallback";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyRiderInstructionsChanged } from "@/lib/notifications/order-events";
import {
  columnKnownMissing,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/** `orders.delivery_instructions` arrives with 0082. */
export const INSTRUCTIONS_COLUMN = "orders.delivery_instructions";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Record the customer's delivery instructions on an order they just placed.
 *
 * Written with the service role, after the order exists, because 0082 locks
 * the column against direct writes by anyone but an admin: a customer cannot
 * PATCH `delivery_instructions` onto an order (or rewrite it later) through
 * PostgREST. The update is scoped to the order AND its customer, so the
 * service role can only ever touch the row the caller has just created.
 * `instructions` must already have passed `normalizeInstructions`.
 *
 * Before 0082 is applied the column does not exist, and placing the order must
 * keep working: the write is retried as the old behaviour — the note folded
 * onto the end of the address line — through `writeWithColumnFallback`, which
 * recognises PGRST204 (a write naming an unknown column) as well as 42703 and
 * remembers the answer for the life of the process.
 *
 * Never throws. The order is already real; a lost note is reported
 * (`ok: false`, and to telemetry) rather than turned into a failed checkout.
 */
export async function saveOrderInstructions(input: {
  orderId: string;
  customerId: string;
  instructions: string | null;
  address: { label: string; line: string; lat?: number | null; lng?: number | null };
  /** Tests only. */
  client?: AdminClient;
}): Promise<{ ok: boolean }> {
  if (!input.instructions) return { ok: true };

  try {
    const admin = input.client ?? createAdminClient();
    const { error } = await writeWithColumnFallback(
      {
        knownMissing: () => columnKnownMissing(INSTRUCTIONS_COLUMN),
        remember: (present) => rememberColumn(INSTRUCTIONS_COLUMN, present),
      },
      (withColumn) =>
        admin
          .from("orders")
          .update(
            withColumn
              ? { delivery_instructions: input.instructions }
              : {
                  address: {
                    ...input.address,
                    line: foldIntoAddressLine(input.address.line, input.instructions),
                  },
                }
          )
          .eq("id", input.orderId)
          .eq("customer_id", input.customerId)
    );
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    captureError(err, {
      source: "order-instructions/save",
      attrs: { event: "instructions_not_saved", orderId: input.orderId },
    });
    return { ok: false };
  }
}

export type UpdateInstructionsResult =
  | { ok: true; instructions: string | null; riderTold: boolean }
  | { ok: false; error: "not_found" | "order_closed" | "instructions_too_long" | "invalid_instructions" };

/** An order still open to changing its note: anything before delivered / cancelled. */
const CLOSED_ORDER = new Set(["delivered", "cancelled"]);

/**
 * The customer changes their delivery instructions on an order that is not
 * delivered yet (`PATCH /api/orders/[id]/instructions`).
 *
 * The caller has authenticated the customer; ownership is checked here — an
 * order that is not theirs answers `not_found`, the same as one that does not
 * exist. Written with the service role (0082 locks the column against the
 * customer's own client), scoped to the order AND its customer.
 *
 * If a rider holds the delivery (assigned or picked up), they are told: a
 * `delivery_updates` push carrying the new text (Review Focus 3), and a
 * `note` on the delivery's timeline (`method = 'instructions_changed'`, 0087)
 * from which the app can highlight the change. Before 0087 the note is
 * skipped; the push still goes.
 *
 * Throws `RiderSchemaPendingError` when the column does not exist (0082 not
 * applied): there is nowhere to put the change, and folding it into the
 * address line of a live order would move the rider's destination text.
 */
export async function updateOrderInstructions(
  customerId: string,
  orderId: string,
  raw: unknown
): Promise<UpdateInstructionsResult> {
  const norm = normalizeInstructions(raw);
  if (!norm.ok) return norm;
  if (columnKnownMissing(INSTRUCTIONS_COLUMN)) throw new RiderSchemaPendingError("migration_pending: orders.delivery_instructions (0082)");

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, customer_id, status")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; customer_id: string | null; status: string }>();
  if (!order || order.customer_id !== customerId) return { ok: false, error: "not_found" };
  if (CLOSED_ORDER.has(order.status)) return { ok: false, error: "order_closed" };

  const { error } = await admin
    .from("orders")
    .update({ delivery_instructions: norm.value })
    .eq("id", orderId)
    .eq("customer_id", customerId);
  if (error) {
    if (isMissingColumnOnWrite(error)) {
      rememberColumn(INSTRUCTIONS_COLUMN, false);
      throw new RiderSchemaPendingError("migration_pending: orders.delivery_instructions (0082)");
    }
    throw error;
  }

  const { data: delivery } = await admin
    .from("deliveries")
    .select("id, driver_id, status")
    .eq("order_id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; driver_id: string | null; status: string }>();
  const driverId = delivery?.driver_id ?? null;
  if (!delivery || !driverId || !["assigned", "picked_up"].includes(delivery.status)) {
    return { ok: true, instructions: norm.value, riderTold: false };
  }

  try {
    const { error: noteError } = await admin.from("delivery_events").insert({
      delivery_id: delivery.id,
      order_id: orderId,
      driver_id: driverId,
      kind: "note",
      method: "instructions_changed",
      reason: "The customer changed the delivery instructions",
    });
    if (noteError) throw noteError;
  } catch (e) {
    captureError(e, { source: "order-instructions/note", attrs: { event: "instructions_note_failed", orderId } });
  }
  deferNotify(() => notifyRiderInstructionsChanged(driverId, { orderId, instructions: norm.value }));
  return { ok: true, instructions: norm.value, riderTold: true };
}
