"use server";

import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listRiderCandidates, opsAdvance, opsAssign, type OpsResult } from "@/lib/data-access/manager-ops-actions";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { isValidReason } from "@/lib/ops/reasons";
import { decideException } from "@/lib/data-access/delivery-exceptions";
import type { DbOrderStatus, RiderCandidate } from "@/lib/ops/order-contract";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase and apply 0023 to work orders.";

const STAGES: readonly DbOrderStatus[] = ["placed", "kitchen", "ready", "on_the_way"];

/** The board's wording for each refusal the audited RPCs can give. */
const MESSAGES: Record<string, string> = {
  not_found: "That order isn't in your zones any more. Refresh the board.",
  stale: "Someone else moved this order. Refresh to see where it is.",
  terminal: "This order has nowhere further to go.",
  already_assigned: "This order already has a rider.",
  picked_up: "The rider already has the food.",
  reason_required: "Say why first.",
};
const INELIGIBLE: Record<string, string> = {
  offline: "That rider is offline.",
  on_break: "That rider is on a break.",
  stale_fix: "That rider's phone hasn't reported a location for a while.",
  suspended: "That rider is suspended.",
  out_of_zone: "That rider doesn't work this order's zone.",
  current_rider: "That rider is already on this order.",
};

function answer(r: OpsResult): ActionResult {
  if (r.ok) return { ok: true };
  if (r.error === "rider_ineligible") {
    const reason = (r.extra?.reasons as string[] | undefined)?.[0] ?? "";
    return { ok: false, error: INELIGIBLE[reason] ?? "That rider can't take this order right now." };
  }
  return { ok: false, error: MESSAGES[r.error] ?? "That didn't go through. Try again." };
}

/**
 * Advance one order to the next stage — forward-only, one step at a time, as
 * the board always allowed. It goes through the same audited RPC as the
 * Manager app (`ops_advance_order`, 0142): the move, its status event (naming
 * this manager and the reason) and its ops_audit_log row land together, the
 * order's zone is re-checked in the database, and the stale-status race (two
 * managers on one order) still answers "someone else moved this order". Every
 * manager status change carries a reason (design §6.10); the board offers the
 * same quick reasons as the app.
 */
export async function advanceOrder(
  orderId: string,
  expected: string,
  reason: string
): Promise<ActionResult> {
  // ["manager", "admin"] matches the /manager layout, which admits both.
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.move_status"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!(STAGES as readonly string[]).includes(expected)) {
    return { ok: false, error: "This order has nowhere further to go." };
  }
  if (!isValidReason(reason)) return { ok: false, error: "Pick a reason first." };

  const result = await opsAdvance(
    { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" },
    orderId,
    expected as DbOrderStatus,
    reason.trim(),
    crypto.randomUUID()
  );
  if (result.ok) revalidatePath("/manager");
  return answer(result);
}

/**
 * Hand an order to a specific rider, through `ops_assign_rider` (0142): the
 * rider must be online with a recent fix and work the order's zone — unless
 * the manager overrides offline / on a break / no fresh fix with a reason,
 * which is recorded as an override — the assignment and its audit row land
 * together, and the rider and the kitchen are told after the response. A rider
 * who self-assigned in the same moment wins; the board says so.
 */
export async function assignRider(
  orderId: string,
  riderId: string,
  opts: { override?: boolean; reason?: string } = {}
): Promise<ActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.assign_rider"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!orderId || !riderId) return { ok: false, error: "Pick a rider first." };
  const override = opts.override === true;
  if (override && !isValidReason(opts.reason)) return { ok: false, error: "Say why you are overriding." };

  const result = await opsAssign(
    { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" },
    orderId,
    riderId,
    opts.reason?.trim() || null,
    crypto.randomUUID(),
    override
  );
  if (result.ok) revalidatePath("/manager");
  return answer(result);
}

/**
 * The riders this manager may put on this order, eligible first, each with
 * the reason they cannot take it when they cannot — the same list, the same
 * rule (src/lib/dispatch/eligibility.ts) as the Manager app's picker and
 * dispatch. Null when the order is missing or outside the manager's zones.
 */
export async function riderCandidatesFor(orderId: string): Promise<RiderCandidate[] | null> {
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.assign_rider"))) return null;
  if (!isSupabaseConfigured) return null;
  const scope = await staffScopeFor({ id: profile.id, role: profile.role === "admin" ? "admin" : "manager" });
  return listRiderCandidates(scope, orderId, new Date());
}

/**
 * Decide a rider's delivery exception from the web board — the same audited
 * decision and idempotent effects as the Manager app (decideException).
 */
export async function decideExceptionAction(
  exceptionId: string,
  decision: "approve" | "reject" | "acknowledge",
  note?: string
): Promise<ActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (profile.role !== "admin" && !(await staffFeatureOn("manager.exceptions.decide"))) {
    return { ok: false, error: FEATURE_OFF_MESSAGE };
  }
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  const result = await decideException({ id: profile.id, role: profile.role === "admin" ? "admin" : "manager" }, exceptionId, decision, note);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "That exception isn't in your zones.",
      already_resolved: "Someone already decided this. Refresh.",
      invalid_decision: "That decision doesn't fit this kind of exception.",
      note_required: "Say why you are rejecting it.",
      effect_failed: "Decision saved; finishing it failed — try again.",
    };
    return { ok: false, error: messages[result.error] ?? "That didn't go through." };
  }
  revalidatePath("/manager");
  return { ok: true };
}
