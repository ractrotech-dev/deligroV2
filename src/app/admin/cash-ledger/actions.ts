"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";
import { confirmManagerHandover, recordCashReceived } from "@/lib/data-access/cod-handovers";
import { alreadyDecidedMessage, decideDeposit } from "@/lib/data-access/rider-cash";

/**
 * The owner's side of "A manager or the owner confirms they received it" (rule
 * book, "Rider cash"). Admin only: every action checks the role, then calls one
 * audited database function that checks it again. No action moves money; each
 * records that cash changed hands, and who confirmed it.
 */

const DEMO = "Demo mode: connect Supabase to record cash.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CashLedgerResult {
  ok: boolean;
  error?: string;
  /** It worked, and there is something the owner should look at. */
  warning?: string;
}

async function gate(key: string): Promise<{ id: string } | { error: string }> {
  const admin = await requireRole("admin");
  if (!isSupabaseConfigured) return { error: DEMO };
  const limit = await rateLimit(`${key}:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { error: "Slow down a moment." };
  return { id: admin.id };
}

/** Confirm or dispute a deposit a rider declared. The first decision stands. */
export async function decideDepositAsOwnerAction(input: {
  depositId: string;
  decision: "confirm" | "dispute";
  note?: string;
}): Promise<CashLedgerResult> {
  const g = await gate("admin-cash-deposit");
  if ("error" in g) return { ok: false, error: g.error };
  if (input.decision !== "confirm" && input.decision !== "dispute") {
    return { ok: false, error: "Choose confirm or dispute." };
  }
  const note = input.note?.trim() || undefined;
  if (input.decision === "dispute" && (!note || note.length < 3)) {
    return { ok: false, error: "Say what is wrong. The rider will read it." };
  }
  const result = await decideDeposit({ id: g.id, role: "admin" }, input.depositId, input.decision, note);
  revalidatePath("/admin/cash-ledger");
  if (!result.ok) {
    switch (result.error) {
      case "already_decided":
        return { ok: false, error: alreadyDecidedMessage(result.decided) };
      case "manual_handover_exists":
        return {
          ok: false,
          error: `Cash from this rider on ${result.day ?? "that day"} is already recorded. Dispute the deposit instead, so it isn't counted twice.`,
        };
      case "note_required":
        return { ok: false, error: "Say what is wrong. The rider will read it." };
      default:
        return { ok: false, error: "That deposit no longer exists." };
    }
  }
  return result.warning
    ? { ok: true, warning: `Confirmed, but this is more than the ${formatINR(result.warning.pending)} this rider was recorded as holding.` }
    : { ok: true };
}

/** Cash the owner received directly, from a rider or a manager. */
export async function recordCashReceivedAction(input: {
  kind: "rider" | "manager";
  fromUserId: string;
  amount: number;
  note?: string;
  /** One per filled-in form, so a double click records once. */
  clientActionId: string;
}): Promise<CashLedgerResult> {
  const g = await gate("admin-cash-received");
  if ("error" in g) return { ok: false, error: g.error };
  if (input.kind !== "rider" && input.kind !== "manager") return { ok: false, error: "Choose a rider or a manager." };
  if (typeof input.fromUserId !== "string" || !UUID.test(input.fromUserId)) {
    return { ok: false, error: input.kind === "rider" ? "Pick the rider." : "Pick the manager." };
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > 500) return { ok: false, error: "That note is too long." };
  const result = await recordCashReceived({
    actorId: g.id,
    kind: input.kind,
    fromUserId: input.fromUserId,
    amount: input.amount,
    note: note || null,
    clientActionId: typeof input.clientActionId === "string" && UUID.test(input.clientActionId) ? input.clientActionId : null,
  });
  if (result.ok) revalidatePath("/admin/cash-ledger");
  return result;
}

/** Confirm a manager's own "I gave it to the owner" row. Adds no money. */
export async function confirmManagerHandoverAction(input: { handoverId: string }): Promise<CashLedgerResult> {
  const g = await gate("admin-cash-confirm");
  if ("error" in g) return { ok: false, error: g.error };
  if (typeof input.handoverId !== "string" || !UUID.test(input.handoverId)) {
    return { ok: false, error: "That handover no longer exists." };
  }
  const result = await confirmManagerHandover(g.id, input.handoverId);
  revalidatePath("/admin/cash-ledger");
  return result;
}
