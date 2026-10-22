import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { writeWithColumnFallback, type ColumnLatch } from "@/lib/data-access/column-fallback";
import { recordDomain } from "@/lib/obs/emit";

/**
 * Proof-of-delivery photo retention (ruling P8-R4; design §7.5 "deleted after
 * 90 days by the cron").
 *
 * A door photo is deleted from the private `delivery-proofs` bucket 90 days
 * after its delivery ENDED, `deliveries.pod_photo_path` is cleared and
 * `pod_photo_removed_at` stamped, so the customer's and ops' viewers can say
 * "Photo removed after 90 days" rather than nothing. "Ended" is:
 *
 *   - delivered: `delivered_at` — also for a row a staff correction later moved
 *     away from delivered (the guard keeps `delivered_at`; the 90 days count
 *     from the delivery the photo proved);
 *   - failed: `failed_at`;
 *   - cancelled without ever being delivered: `picked_up_at` (a photo can only
 *     be taken after pickup, and the row carries no cancellation stamp).
 *
 * The delivery and its `delivery_events` audit rows are untouched (the PGlite
 * proof of 0083 shows every guard on `deliveries` lets this one write through
 * with status, stamps, audit and ledger unchanged).
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
/** Candidates read per kind of ending: more than the batch, so held photos cannot starve the rest. */
const CANDIDATE_LIMIT = 150;
/** Ids per `.in()` filter: keeps each GET's query string well under URL limits. */
const IN_CHUNK = 50;
const OPEN_EXCEPTION = "pending";
const CLOSED_TICKET = ["resolved", "closed"] as const;

/** `deliveries.pod_photo_removed_at` (0082): the same latch key order-proof.ts reads. */
const REMOVED_COLUMN = "deliveries.pod_photo_removed_at";
const removedLatch: ColumnLatch = {
  knownMissing: () => columnKnownMissing(REMOVED_COLUMN),
  remember: (present) => rememberColumn(REMOVED_COLUMN, present),
};

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
  status: string;
  delivered_at: string | null;
  failed_at: string | null;
  picked_up_at: string | null;
}

interface Candidate extends CandidateRow {
  endedAt: string;
}

type Admin = ReturnType<typeof createAdminClient>;

const COLUMNS = "id, order_id, pod_photo_path, status, delivered_at, failed_at, picked_up_at";

function chunks<T>(xs: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * The photos whose delivery ended before `cutoff`, oldest ending first.
 * Three reads, one per kind of ending, each indexed by its own stamp.
 */
async function readCandidates(supabase: Admin, cutoff: string): Promise<Candidate[] | null> {
  const base = () =>
    supabase.from("deliveries").select(COLUMNS).not("pod_photo_path", "is", null);
  const reads = await Promise.all([
    // Delivered — and delivered, then corrected away (any other status).
    base().neq("status", "failed").lt("delivered_at", cutoff).order("delivered_at", { ascending: true }).limit(CANDIDATE_LIMIT),
    base().eq("status", "failed").lt("failed_at", cutoff).order("failed_at", { ascending: true }).limit(CANDIDATE_LIMIT),
    base()
      .eq("status", "cancelled")
      .is("delivered_at", null)
      .lt("picked_up_at", cutoff)
      .order("picked_up_at", { ascending: true })
      .limit(CANDIDATE_LIMIT),
  ]);
  const byId = new Map<string, Candidate>();
  for (const { data, error } of reads) {
    if (error) {
      // Before 0082 there is no photo column and so nothing to delete.
      if (isMissingColumn(error)) return null;
      throw error;
    }
    for (const r of (data ?? []) as CandidateRow[]) {
      if (!r.pod_photo_path) continue;
      const endedAt = r.status === "failed" ? r.failed_at : (r.delivered_at ?? r.picked_up_at);
      // The database already compared the stamp with the cutoff; Postgres and
      // JS print instants differently, so they are compared as times here.
      if (endedAt) byId.set(r.id, { ...r, endedAt });
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
}

/** Order ids among the candidates that still have something open about them. */
async function ordersInQuestion(supabase: Admin, candidates: Candidate[]): Promise<Set<string>> {
  const held = new Set<string>();
  const deliveryIds = candidates.map((r) => r.id);
  const orderIds = [...new Set(candidates.map((r) => r.order_id))];
  const reads = await Promise.all([
    ...chunks(deliveryIds).map((ids) =>
      supabase.from("delivery_exceptions").select("order_id").in("delivery_id", ids).eq("status", OPEN_EXCEPTION)
    ),
    ...chunks(orderIds).map((ids) =>
      supabase
        .from("support_tickets")
        .select("order_id")
        .in("order_id", ids)
        .not("status", "in", `(${CLOSED_TICKET.join(",")})`)
    ),
  ]);
  for (const { data, error } of reads) {
    // A missing table holds nothing; any other failure holds everything (fail
    // closed: never delete evidence we could not check).
    if (error && !isMissingTable(error)) throw error;
    for (const r of (data ?? []) as { order_id: string | null }[]) if (r.order_id) held.add(r.order_id);
  }
  return held;
}

/**
 * Delete proof photos of deliveries that ended more than 90 days before `now`.
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

  const candidates = await readCandidates(supabase, cutoff);
  if (!candidates || candidates.length === 0) return { removed: 0, held: 0, failed: 0 };

  const holds = await ordersInQuestion(supabase, candidates);
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
  const cleared: { deliveryId: string; orderId: string; path: string; status: string; endedAt: string }[] = [];
  for (const r of due) {
    // The stamp is optional: a database whose 0082 predates it (e.g. a copy
    // applied from another branch) answers PGRST204 on the write, and the path
    // is then cleared alone. Viewers on such a database read a null path as
    // "no photo" rather than "removed after 90 days" — acceptable: nothing
    // points at a deleted file, and the stamp arrives with the next 0082.
    const res = await writeWithColumnFallback(removedLatch, (withStamp) =>
      supabase
        .from("deliveries")
        .update(withStamp ? { pod_photo_path: null, pod_photo_removed_at: stamp } : { pod_photo_path: null })
        .eq("id", r.id)
        .eq("pod_photo_path", r.pod_photo_path)
        .select("id")
    );
    if (res.error) {
      failed++;
      recordDomain("retention.proof_photo", "error", "proof photo row not cleared", {
        error: res.error,
        orderId: r.order_id,
        attrs: { deliveryId: r.id },
      });
      continue;
    }
    // No row matched: somebody changed the path meanwhile. Nothing to count.
    if ((res.data ?? []).length === 0) continue;
    removed++;
    cleared.push({ deliveryId: r.id, orderId: r.order_id, path: r.pod_photo_path, status: r.status, endedAt: r.endedAt });
  }

  if (removed > 0) {
    recordDomain("retention.proof_photo", "info", `removed ${removed} proof photo(s) older than ${PROOF_RETENTION_DAYS} days`, {
      attrs: { removed, held, failed, cutoff, items: cleared },
    });
  }
  return { removed, held, failed };
}
