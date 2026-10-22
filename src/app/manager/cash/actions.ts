"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { resolveRecordZone } from "@/lib/auth/manager-scope";
import { riderInScope } from "@/lib/data-access/scoped-riders";
import { decideDeposit } from "@/lib/data-access/rider-cash";
import { resolveCashDispute } from "@/lib/data-access/manager-cash";
import {
  recordCodHandover,
  type CashHandoverLeg,
} from "@/lib/data-access/cod-handovers";
import {
  recordOperationalExpense,
  type ExpenseCategory,
  type ExpensePaymentMethod,
} from "@/lib/data-access/operational-expenses";

/**
 * Two server actions for the offline-but-recorded cash chain: a handover leg
 * (rider to manager, or manager to owner) and an operational expense (rider
 * salary, EV bike maintenance/charging, or another small cost).
 *
 * Both write to a table with no insert policy for any authenticated role —
 * every write goes through the service role from here, behind
 * requireRole(["manager", "admin"]), matching the /manager layout. Neither
 * moves money: they record that a handover or a spend happened, which is the
 * point (AGENTS.md #3: a Server Action is a public HTTP endpoint).
 */

const DEMO = "Demo mode: connect Supabase and apply migration 0047 to record cash.";

export interface CashActionResult {
  ok: boolean;
  error?: string;
}

export async function recordHandoverAction(input: {
  leg: CashHandoverLeg;
  fromUserId?: string | null;
  toUserId?: string | null;
  amount: number;
  note?: string;
  zoneId?: string | null;
}): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  // A handful of these a day at most — well above what a real shift needs,
  // tight enough to slow a stolen session down.
  const limit = await rateLimit(`cod-handover:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  const scope = await staffScopeFor(profile);
  const zone = resolveRecordZone(scope, input.zoneId);
  if (!zone.ok) return zone;
  // Cash from a rider is recorded only for a rider in the manager's zones —
  // never another zone's rider into this zone's books.
  if (input.leg === "rider_to_manager" && input.fromUserId && !(await riderInScope(scope, input.fromUserId))) {
    return { ok: false, error: "That rider isn't in your zones." };
  }

  const result = await recordCodHandover({
    leg: input.leg,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    amount: input.amount,
    note: input.note,
    recordedBy: profile.id,
    zoneId: zone.zoneId,
  });
  if (result.ok) revalidatePath("/manager/cash");
  return result;
}

export async function recordExpenseAction(input: {
  category: ExpenseCategory;
  amount: number;
  riderId?: string | null;
  paymentMethod: ExpensePaymentMethod;
  note?: string;
  zoneId?: string | null;
}): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const limit = await rateLimit(`operational-expense:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  const scope = await staffScopeFor(profile);
  const zone = resolveRecordZone(scope, input.zoneId);
  if (!zone.ok) return zone;
  if (input.riderId && !(await riderInScope(scope, input.riderId))) {
    return { ok: false, error: "That rider isn't in your zones." };
  }

  const result = await recordOperationalExpense({
    category: input.category,
    amount: input.amount,
    riderId: input.riderId,
    paymentMethod: input.paymentMethod,
    note: input.note,
    recordedBy: profile.id,
    zoneId: zone.zoneId,
  });
  if (result.ok) revalidatePath("/manager/cash");
  return result;
}

/**
 * Confirm or dispute a cash deposit a rider declared (§5.14). Confirming writes
 * the rider → manager handover; both are one audited RPC (0152) that re-checks
 * the rider's zone in the database. Same gates as the actions above.
 */
export async function decideDepositAction(input: {
  depositId: string;
  decision: "confirm" | "dispute";
  note?: string;
}): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  const limit = await rateLimit(`cash-deposit-decide:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };
  if (input.decision !== "confirm" && input.decision !== "dispute") return { ok: false, error: "Choose confirm or dispute." };
  const note = input.note?.trim() || undefined;
  if (input.decision === "dispute" && (!note || note.length < 3)) {
    return { ok: false, error: "Say what is wrong — the rider will read it." };
  }
  const result = await decideDeposit(
    { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" },
    input.depositId,
    input.decision,
    note
  );
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "already_decided"
          ? "Someone already decided this deposit. Refresh."
          : result.error === "manual_handover_exists"
            ? "This cash was already recorded by hand for that day. Dispute the deposit instead, so it isn't counted twice."
            : result.error === "note_required"
            ? "Say what is wrong — the rider will read it."
            : "That deposit isn't in your zones.",
    };
  }
  revalidatePath("/manager/cash");
  return { ok: true };
}

/** Close a rider's cash dispute with what was found. Audited (0152). */
export async function resolveDisputeAction(input: { disputeId: string; resolution: string }): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  const limit = await rateLimit(`cash-dispute-resolve:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };
  const resolution = input.resolution?.trim() ?? "";
  if (resolution.length < 3 || resolution.length > 500) return { ok: false, error: "Write what you found (3–500 characters)." };
  const scope = await staffScopeFor(profile);
  const result = await resolveCashDispute(
    { profile, scope, permissions: {} },
    input.disputeId,
    { clientActionId: randomUUID(), resolution }
  );
  if (!result.ok) {
    return { ok: false, error: result.error === "already_resolved" ? "Already resolved. Refresh." : "That dispute isn't in your zones." };
  }
  revalidatePath("/manager/cash");
  return { ok: true };
}
