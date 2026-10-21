"use server";

import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { resolveRecordZone } from "@/lib/auth/manager-scope";
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

  const zone = resolveRecordZone(await staffScopeFor(profile), input.zoneId);
  if (!zone.ok) return zone;

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

  const zone = resolveRecordZone(await staffScopeFor(profile), input.zoneId);
  if (!zone.ok) return zone;

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
