import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { columnKnownMissing, isMissingColumn, isMissingTable, rememberColumn } from "@/lib/data-access/schema-probe";
import { loadDocumentBlockedRiders } from "@/lib/data-access/rider-document-block";

/**
 * Which of these people may be given work right now, apart from being online:
 * the checks a hand-assignment and a "come online" call must make on a rider
 * the system did not pick itself (dispatch's own roster already applies them).
 *
 *   not_rider          no profile, or the role is not `driver`
 *   inactive           the Manager branch's `profiles.account_status` (0151)
 *                      is not `active` — read only when the column exists
 *   rejected           verification `rejected` (ruling P8-R9; Manager 0151's
 *                      rider_can_work says the same)
 *   documents_expired  `block_dispatch_on_expired_docs` is on and a document
 *                      that applies has expired (ruling P8-R8)
 *
 * Service role; callers authorise first (AGENTS.md rule 5). A read failure
 * other than a missing table or column throws: "could not check" is never
 * "may work".
 */
export type UnworkableReason = "not_rider" | "inactive" | "rejected" | "documents_expired";

const ACCOUNT_STATUS = "profiles.account_status";

type PgError = { code?: string; message?: string };

async function readProfiles(
  supabase: ReturnType<typeof createAdminClient>,
  ids: string[]
): Promise<Map<string, { role: string; account_status?: string | null }>> {
  const withStatus = !columnKnownMissing(ACCOUNT_STATUS);
  const read = (cols: string) =>
    supabase
      .from("profiles")
      .select(cols)
      .in("id", ids)
      .overrideTypes<{ id: string; role: string; account_status?: string | null }[]>();
  let { data, error } = await read(withStatus ? "id, role, account_status" : "id, role");
  if (error && withStatus && isMissingColumn(error as PgError)) {
    rememberColumn(ACCOUNT_STATUS, false);
    ({ data, error } = await read("id, role"));
  }
  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.id, p]));
}

/** The riders in `ids` that may NOT be given work, each with the first reason that applies. */
export async function unworkableRiders(ids: readonly string[], now: Date = new Date()): Promise<Map<string, UnworkableReason>> {
  const out = new Map<string, UnworkableReason>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const supabase = createAdminClient();

  const profiles = await readProfiles(supabase, unique);
  const { data: rows, error } = await supabase
    .from("rider_profiles")
    .select("driver_id, verification_status")
    .in("driver_id", unique)
    .overrideTypes<{ driver_id: string; verification_status: string | null }[]>();
  if (error && !isMissingTable(error) && !isMissingColumn(error)) throw error;
  const verification = new Map((error ? [] : (rows ?? [])).map((r) => [r.driver_id, r.verification_status]));

  const riders: string[] = [];
  for (const id of unique) {
    const p = profiles.get(id);
    if (!p || p.role !== "driver") out.set(id, "not_rider");
    else if (p.account_status != null && p.account_status !== "active") out.set(id, "inactive");
    else if (verification.get(id) === "rejected") out.set(id, "rejected");
    else riders.push(id);
  }
  if (riders.length > 0) {
    for (const id of await loadDocumentBlockedRiders(riders, now)) out.set(id, "documents_expired");
  }
  return out;
}

/** One rider: null when they may be given work. */
export async function riderUnworkable(id: string, now: Date = new Date()): Promise<UnworkableReason | null> {
  return (await unworkableRiders([id], now)).get(id) ?? null;
}

/** What a manager is told when a hand-assignment is refused, in plain English. */
export const UNWORKABLE_MESSAGE: Record<UnworkableReason, string> = {
  not_rider: "That person is not a rider. Pick a rider from the list.",
  inactive: "This rider's account is not active, so they cannot take orders.",
  rejected: "This rider did not pass verification, so they cannot take orders.",
  documents_expired:
    "This rider has an expired document, and expired documents block new orders. Ask them to upload the new one; they can take orders once it is checked.",
};
