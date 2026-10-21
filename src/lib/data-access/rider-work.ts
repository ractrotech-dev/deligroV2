import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";

/**
 * Who may work (0151 `rider_can_work`, read here for the TypeScript side of the
 * one eligibility rule): a rider whose account is suspended, or whose
 * verification was rejected, cannot go online, is never offered an order and
 * cannot be assigned one.
 *
 * Before 0151 is applied the columns do not exist, and nobody is blocked —
 * the state the database itself would report. Any OTHER read failure throws:
 * the callers (dispatch, the picker, the rider API gate) must not treat "could
 * not read" as "free to work".
 *
 * Service role. Callers authorise first (AGENTS.md rule 5).
 */

export type WorkBlock = "account_suspended" | "verification_rejected";

// 100 ids is about 4 KB of URL, the same budget as readInChunks.
const CHUNK = 100;

/** Riders in `ids` who may not work, and why. A rider absent from the map may work. */
export async function loadWorkBlocks(ids: readonly string[]): Promise<Map<string, WorkBlock>> {
  const out = new Map<string, WorkBlock>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const supabase = createAdminClient();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const [accounts, profiles] = await Promise.all([
      supabase.from("profiles").select("id, account_status").in("id", slice),
      supabase.from("rider_profiles").select("driver_id, verification_status").in("driver_id", slice),
    ]);
    if (accounts.error && !isMissingColumn(accounts.error)) throw accounts.error;
    if (profiles.error && !isMissingColumn(profiles.error) && !isMissingTable(profiles.error)) throw profiles.error;
    for (const p of (accounts.error ? [] : accounts.data ?? []) as { id: string; account_status: string | null }[]) {
      if (p.account_status && p.account_status !== "active") out.set(p.id, "account_suspended");
    }
    for (const p of (profiles.error ? [] : profiles.data ?? []) as { driver_id: string; verification_status: string | null }[]) {
      if (p.verification_status === "rejected" && !out.has(p.driver_id)) out.set(p.driver_id, "verification_rejected");
    }
  }
  return out;
}

/** One rider's block, or null when they may work. */
export async function riderWorkBlock(riderId: string): Promise<WorkBlock | null> {
  return (await loadWorkBlocks([riderId])).get(riderId) ?? null;
}
