import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { foldIntoAddressLine } from "@/lib/orders/instructions";
import { writeWithColumnFallback } from "@/lib/data-access/column-fallback";
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
