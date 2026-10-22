import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { recordDomain } from "@/lib/obs/emit";

/**
 * Proof-of-delivery photo retention (ruling P8-R4; design §7.5 "deleted after
 * 90 days by the cron").
 *
 * A delivered order's door photo is deleted from the private `delivery-proofs`
 * bucket 90 days after delivery, `deliveries.pod_photo_path` is cleared and
 * `pod_photo_removed_at` stamped, so the customer's and ops' viewers can say
 * "Photo removed after 90 days" rather than nothing. The delivery and its
 * `delivery_events` audit rows are untouched (the PGlite proof of 0083 shows
 * every guard on `deliveries` lets this one write through unchanged).
 *
 * Kept while the order is still in question: an open delivery exception
 * (`status = 'pending'`) or an open support ticket linked to the order (any
 * status but resolved / closed). Those photos are looked at again on the next
 * run, once the case is closed.
 *
 * Run from the dispatch sweep (`sweep.ts`), at most once an hour, at most
 * `PROOF_PURGE_BATCH` photos a run, oldest first. Idempotent: a row whose path
 * is already null is never selected, the clearing update is conditional on the
 * same path, and removing an object that is already gone is not an error — so
 * a run that dies between the storage delete and the row update simply
 * finishes the job next time. Service role only; nothing here is reachable
 * from a request.
 */

export const PROOF_BUCKET = "delivery-proofs";
export const PROOF_RETENTION_DAYS = 90;
/** Photos removed per run, at most. */
export const PROOF_PURGE_BATCH = 100;
/** Candidates read per run: more than the batch, so held photos cannot starve the rest. */
const CANDIDATE_LIMIT = PROOF_PURGE_BATCH * 3;
const OPEN_EXCEPTION = "pending";
const CLOSED_TICKET = ["resolved", "closed"] as const;

export interface ProofPurgeResult {
  /** Photos deleted and their rows cleared this run. */
  removed: number;
  /** Old photos kept because the order has an open exception or ticket. */
  held: number;
  /** Photos whose delete or row update failed; retried next run. */
  failed: number;
}

interface CandidateRow {
  id: string;
  order_id: string;
  pod_photo_path: string;
  delivered_at: string;
}

type Admin = ReturnType<typeof createAdminClient>;

/** Order ids among `orderIds` that still have something open about them. */
async function ordersInQuestion(supabase: Admin, deliveryIds: string[], orderIds: string[]): Promise<Set<string>> {
  const held = new Set<string>();
  const [exceptions, tickets] = await Promise.all([
    supabase
      .from("delivery_exceptions")
      .select("order_id, delivery_id")
      .in("delivery_id", deliveryIds)
      .eq("status", OPEN_EXCEPTION),
    supabase
      .from("support_tickets")
      .select("order_id")
      .in("order_id", orderIds)
      .not("status", "in", `(${CLOSED_TICKET.join(",")})`),
  ]);
  // A missing table holds nothing; any other failure holds everything (fail
  // closed: never delete evidence we could not check).
  if (exceptions.error && !isMissingTable(exceptions.error)) throw exceptions.error;
  if (tickets.error && !isMissingTable(tickets.error)) throw tickets.error;
  for (const r of (exceptions.data ?? []) as { order_id: string | null }[]) if (r.order_id) held.add(r.order_id);
  for (const r of (tickets.data ?? []) as { order_id: string | null }[]) if (r.order_id) held.add(r.order_id);
  return held;
}

/**
 * Delete proof photos of deliveries delivered more than 90 days before `now`.
 * Never throws for a single photo; throws only when the candidates or the
 * hold checks cannot be read (the sweep counts that as 0 and retries).
 */
export async function purgeExpiredProofPhotos(
  now: Date = new Date(),
  opts: { batch?: number } = {}
): Promise<ProofPurgeResult> {
  const supabase = createAdminClient();
  const batch = Math.max(1, Math.min(opts.batch ?? PROOF_PURGE_BATCH, PROOF_PURGE_BATCH));
  const cutoff = new Date(now.getTime() - PROOF_RETENTION_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("deliveries")
    .select("id, order_id, pod_photo_path, delivered_at")
    .eq("status", "delivered")
    .not("pod_photo_path", "is", null)
    .lt("delivered_at", cutoff)
    .order("delivered_at", { ascending: true })
    .limit(CANDIDATE_LIMIT);
  if (error) {
    // Before 0082 there is no photo column and so nothing to delete.
    if (isMissingColumn(error)) return { removed: 0, held: 0, failed: 0 };
    throw error;
  }
  const candidates = ((data ?? []) as CandidateRow[]).filter((r) => r.pod_photo_path);
  if (candidates.length === 0) return { removed: 0, held: 0, failed: 0 };

  const holds = await ordersInQuestion(
    supabase,
    candidates.map((r) => r.id),
    [...new Set(candidates.map((r) => r.order_id))]
  );
  const due = candidates.filter((r) => !holds.has(r.order_id)).slice(0, batch);
  const held = candidates.filter((r) => holds.has(r.order_id)).length;
  if (due.length === 0) return { removed: 0, held, failed: 0 };

  // Storage first: if the delete fails the row keeps its path and the next run
  // tries again. Deleting an object that is already gone succeeds.
  const { error: removeError } = await supabase.storage.from(PROOF_BUCKET).remove(due.map((r) => r.pod_photo_path));
  if (removeError) {
    recordDomain("retention.proof_photo", "error", "proof photo delete failed", {
      error: removeError,
      attrs: { attempted: due.length },
    });
    return { removed: 0, held, failed: due.length };
  }

  const stamp = now.toISOString();
  let removed = 0;
  let failed = 0;
  const cleared: { deliveryId: string; orderId: string; path: string; deliveredAt: string }[] = [];
  for (const r of due) {
    const clear = (withStamp: boolean) =>
      supabase
        .from("deliveries")
        .update(withStamp ? { pod_photo_path: null, pod_photo_removed_at: stamp } : { pod_photo_path: null })
        .eq("id", r.id)
        .eq("pod_photo_path", r.pod_photo_path)
        .select("id");
    let res = await clear(true);
    if (res.error && isMissingColumn(res.error)) res = await clear(false);
    if (res.error) {
      failed++;
      recordDomain("retention.proof_photo", "error", "proof photo row not cleared", {
        error: res.error,
        orderId: r.order_id,
        attrs: { deliveryId: r.id },
      });
      continue;
    }
    // No row matched: somebody changed the path meanwhile (a retake cannot
    // happen on a delivered row, but a correction could). Nothing to count.
    if ((res.data ?? []).length === 0) continue;
    removed++;
    cleared.push({ deliveryId: r.id, orderId: r.order_id, path: r.pod_photo_path, deliveredAt: r.delivered_at });
  }

  if (removed > 0) {
    recordDomain("retention.proof_photo", "info", `removed ${removed} proof photo(s) older than ${PROOF_RETENTION_DAYS} days`, {
      attrs: { removed, held, failed, cutoff, items: cleared },
    });
  }
  return { removed, held, failed };
}
