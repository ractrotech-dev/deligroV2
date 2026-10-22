"use server";

import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  recordCodHandover,
  type CashHandoverLeg,
} from "@/lib/data-access/cod-handovers";
import { decideDeposit, resolveCashDispute } from "@/lib/data-access/rider-cash";
import { formatINR } from "@/lib/utils/format";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
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
}): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  // A handful of these a day at most — well above what a real shift needs,
  // tight enough to slow a stolen session down.
  const limit = await rateLimit(`cod-handover:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  const result = await recordCodHandover({ ...input, recordedBy: profile.id });
  if (result.ok) revalidatePath("/manager/cash");
  return result;
}

export async function recordExpenseAction(input: {
  category: ExpenseCategory;
  amount: number;
  riderId?: string | null;
  paymentMethod: ExpensePaymentMethod;
  note?: string;
}): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const limit = await rateLimit(`operational-expense:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  const result = await recordOperationalExpense({ ...input, recordedBy: profile.id });
  if (result.ok) revalidatePath("/manager/cash");
  return result;
}

/**
 * Rider deposits (0085): confirm or dispute what a rider says they handed over.
 * Both are one database function (`ops_decide_cash_deposit`, shared with the
 * Manager branch's 0152): confirming writes the one `cod_handovers` row dated
 * to the day the rider declared it, disputing needs a note the rider reads. If
 * that handover was already recorded by hand for that day the confirmation is
 * refused with `manual_handover_exists`, because the same cash would count
 * twice.
 */
export interface DepositActionResult {
  ok: boolean;
  error?: string;
  /** Set with `error: "manual_handover_exists"`: the IST day, `YYYY-MM-DD`. */
  day?: string;
  /** A confirmed deposit larger than the cash the rider was recorded as holding. */
  warning?: string;
}

const DEPOSIT_ERRORS: Record<string, string> = {
  not_found: "That deposit no longer exists.",
  already_decided: "Someone has already decided this deposit.",
  note_required: "Say why you are disputing it (at least 3 characters). The rider reads this.",
};

/** The refusal for a deposit whose day already has a handover written by hand. */
function manualHandoverMessage(day: string): string {
  return `A handover for this rider on ${day} was already recorded by hand \u2014 check the cash ledger.`;
}

export async function decideDepositAction(input: {
  id: string;
  decision: "confirm" | "dispute";
  note?: string;
}): Promise<DepositActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (typeof input?.id !== "string" || (input.decision !== "confirm" && input.decision !== "dispute")) {
    return { ok: false, error: "Not a valid decision." };
  }

  const limit = await rateLimit(`cash-deposit-decision:${profile.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  try {
    const result = await decideDeposit(
      { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" },
      input.id,
      input.decision,
      typeof input.note === "string" ? input.note : undefined
    );
    if (result.ok) {
      revalidatePath("/manager/cash");
      revalidatePath("/admin/cash-ledger");
      return result.warning
        ? {
            ok: true,
            warning: `Confirmed, but this is more than the ${formatINR(result.warning.pending)} this rider was recorded as holding.`,
          }
        : { ok: true };
    }
    if (result.error === "manual_handover_exists") {
      return { ok: false, error: manualHandoverMessage(result.day ?? "that day"), day: result.day };
    }
    return { ok: false, error: DEPOSIT_ERRORS[result.error] ?? "That didn't save. Try again." };
  } catch (e) {
    return {
      ok: false,
      error: isRiderSchemaPending(e)
        ? "Rider deposits need migration 0085."
        : "That didn't save. Try again.",
    };
  }
}

export async function resolveCashDisputeAction(input: {
  id: string;
  resolution: string;
}): Promise<CashActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.cash"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (typeof input?.id !== "string" || typeof input.resolution !== "string") {
    return { ok: false, error: "Not a valid resolution." };
  }

  const limit = await rateLimit(`cash-dispute-resolve:${profile.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: "Slow down a moment." };

  try {
    const result = await resolveCashDispute({ id: profile.id }, input.id, input.resolution);
    if (result.ok) {
      revalidatePath("/manager/cash");
      revalidatePath("/admin/cash-ledger");
      return { ok: true };
    }
    return {
      ok: false,
      error:
        result.error === "resolution_required"
          ? "Write what was decided. The rider can read it."
          : result.error === "already_resolved"
            ? "This dispute is already resolved."
            : "That dispute no longer exists.",
    };
  } catch {
    return { ok: false, error: "That didn't save. Try again." };
  }
}
