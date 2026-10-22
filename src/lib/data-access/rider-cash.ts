import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyRiderDepositDecided } from "@/lib/notifications/payment-events";

/**
 * Rider cash — the Rider plan's `rider-cash.ts` (rider phase 5) decision
 * function, created here first with its exact signature for the Manager app
 * and the web /manager cash page. The decision, the `cod_handovers` rider →
 * manager leg it writes on confirmation (the one cash ledger, 0047) and the
 * audit row are one RPC, `ops_decide_cash_deposit` (0152), which re-checks the
 * actor against the rider's zones in the database.
 *
 * Callers authorise first (requireRole / managerApiContext + manager.cash).
 */

export interface DepositDecisionError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * The one call both paths make. `replayed` true = this client action was
 * already done (no second notice).
 */
export async function decideDepositRpc(
  actorId: string,
  id: string,
  decision: "confirm" | "dispute",
  note: string | null,
  clientActionId: string | null
): Promise<{ ok: true; replayed: boolean } | { ok: false; error: DepositDecisionError }> {
  const { data, error } = await createAdminClient().rpc("ops_decide_cash_deposit", {
    p_actor: actorId,
    p_deposit: id,
    p_decision: decision,
    p_note: note,
    p_zone: null,
    p_client_action_id: clientActionId,
  });
  if (error) return { ok: false, error };
  const replayed = (data as { replayed?: boolean } | null)?.replayed === true;
  if (!replayed) deferNotify(() => notifyRiderDepositDecided(id));
  return { ok: true, replayed };
}

export async function decideDeposit(
  actor: { id: string; role: "manager" | "admin" },
  id: string,
  decision: "confirm" | "dispute",
  note?: string
): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_decided" | "note_required" | "manual_handover_exists" }> {
  const r = await decideDepositRpc(actor.id, id, decision, note?.trim() || null, null);
  if (r.ok) return { ok: true };
  const message = (r.error.message ?? "").trim();
  if (message === "forbidden" || r.error.code === "42501") return { ok: false, error: "not_found" };
  if (message === "already_decided") return { ok: false, error: "already_decided" };
  if (message === "note_required") return { ok: false, error: "note_required" };
  // A leg for this rider and day was already written by hand (0152): the cash
  // is on record once, so the deposit is disputed rather than confirmed.
  if (message === "manual_handover_exists") return { ok: false, error: "manual_handover_exists" };
  throw new Error(message || "deposit_decision_failed");
}
