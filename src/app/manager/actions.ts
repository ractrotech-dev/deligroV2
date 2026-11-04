"use server";

import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listRiderCandidates, opsAdvance, opsAssign, type OpsResult } from "@/lib/data-access/manager-ops-actions";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { isValidReason } from "@/lib/ops/reasons";
import type { DbOrderStatus, RiderCandidate } from "@/lib/ops/order-contract";
import { FORWARD_STATUSES } from "@/lib/ops/order-actions";
import { rateLimit } from "@/lib/rate-limit";
import {
  decideException,
  listPendingExceptions,
  type OpsException,
} from "@/lib/data-access/delivery-exceptions";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { isExceptionDecision } from "@/lib/rider/exception-rules";
import { riderUnworkable, UNWORKABLE_MESSAGE } from "@/lib/data-access/rider-workable";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase and apply 0023 to work orders.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOO_FAST = "Too many changes at once. Wait a moment and try again.";

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
  reason: string,
  /** Optional: jump straight to a later status (e.g. preparing → delivered). */
  target?: string
): Promise<ActionResult> {
  // ["manager", "admin"] matches the /manager layout, which admits both.
  const profile = await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.move_status"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  // Final review A (minor 7): a stuck button or a script cannot hammer orders.
  const limit = await rateLimit(`manager-advance:${profile.id}`, 60, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };

  if (!(STAGES as readonly string[]).includes(expected)) {
    return { ok: false, error: "This order has nowhere further to go." };
  }
  if (!isValidReason(reason)) return { ok: false, error: "Pick a reason first." };
  if (
    target !== undefined &&
    FORWARD_STATUSES.indexOf(target as DbOrderStatus) <= FORWARD_STATUSES.indexOf(expected as DbOrderStatus)
  ) {
    return { ok: false, error: "Pick a later status." };
  }

  const result = await opsAdvance(
    { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" },
    orderId,
    expected as DbOrderStatus,
    reason.trim(),
    crypto.randomUUID(),
    target as DbOrderStatus | undefined
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

  const limit = await rateLimit(`manager-assign:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_FAST };

  if (!orderId || !riderId) return { ok: false, error: "Pick a rider first." };
  if (!UUID.test(orderId) || !UUID.test(riderId)) return { ok: false, error: "Pick a rider from the list." };
  const override = opts.override === true;
  if (override && !isValidReason(opts.reason)) return { ok: false, error: "Say why you are overriding." };

  // The manager picked this rider, not dispatch, so the checks dispatch makes
  // on its own roster are made here (final review A minor 7, review B minor
  // 3): a driver, an active account, not rejected in verification, and — when
  // the admin switched the block on — no expired document (P8-R8).
  let unworkable: Awaited<ReturnType<typeof riderUnworkable>>;
  try {
    unworkable = await riderUnworkable(riderId);
  } catch {
    return { ok: false, error: "Couldn't check this rider. Try again." };
  }
  if (unworkable) return { ok: false, error: UNWORKABLE_MESSAGE[unworkable] };

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

const DECISION_NOTE_MAX = 300;

/**
 * The "Needs a decision" queue, for a board that polls rather than refreshes
 * (the admin home). Read-only. The rider's phone is dropped unless this
 * operator may call (`manager.call_customer`; an admin always may) — hiding
 * the Call link alone would still ship the number.
 */
export async function listExceptionQueue(): Promise<OpsException[]> {
  const profile = await requireRole(["manager", "admin"]);
  if (!isSupabaseConfigured) return [];
  // A manager's queue is their zones' riders, as in the Manager app.
  const scope = await staffScopeFor({ id: profile.id, role: profile.role === "admin" ? "admin" : "manager" });
  const [items, canCall] = await Promise.all([
    listPendingExceptions({ scope }),
    staffFeatureOn("manager.call_customer"),
  ]);
  return canCall ? items : items.map((x) => ({ ...x, riderPhone: null }));
}

/**
 * The approval was recorded (decisions are final) but what it should have done
 * failed part-way. The same button again finishes it (see the derived key in
 * decideExceptionAction); should that fail too, say exactly what to do by hand.
 */
function effectFailedMessage(kind: string | undefined): string {
  const lead = "Approved, but the change didn't go through. Press Approve again to finish it; if it fails again, ";
  switch (kind) {
    case "failed_delivery":
    case "customer_unreachable":
    case "wrong_address":
      return `${lead}check the order: if it is still live, cancel it from Orders and tell the rider to return the food to the shop.`;
    case "complete_without_code":
      return `${lead}the order is not marked delivered. Mark it delivered from Orders (staff completion), then confirm the cash with the rider.`;
    case "go_offline":
      return `${lead}the rider may still hold the job or still be online. Reassign the order from the board and ask the rider to go offline in the app.`;
    default:
      return `${lead}call the rider and finish it by hand.`;
  }
}

export interface DecideExceptionActionResult extends ActionResult {
  /** Set on an approved failure: false when the order still needs cancelling by hand. */
  orderCancelled?: boolean;
  /** The approval is recorded but its effect failed: `error` says what to do by hand. */
  needsHandling?: boolean;
}

/**
 * A manager or admin decides a rider's exception: approve or reject a
 * request, acknowledge a report. What each approval does — fail and cancel,
 * complete without the code, allow a manual pickup, release the job and take
 * the rider offline — is `decideException` (delivery-exceptions.ts).
 *
 * The actor is this session's profile, never an argument. Rate-limited like
 * every write (AGENTS.md rule 6). A manager needs `manager.exceptions.decide`.
 *
 * The idempotency key is derived — this person, this exception, this decision
 * — so pressing the same button again after an `effect_failed` is a retry the
 * decision RPC recognises: it writes nothing new and the approval's unfinished
 * effects run again. (A decided exception is final, so the key can never
 * stand for a different decision.)
 */
export async function decideExceptionAction(
  exceptionId: string,
  decision: string,
  note?: string
): Promise<DecideExceptionActionResult> {
  const profile = await requireRole(["manager", "admin"]);
  if (profile.role !== "admin" && !(await staffFeatureOn("manager.exceptions.decide"))) {
    return { ok: false, error: FEATURE_OFF_MESSAGE };
  }
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const limit = await rateLimit(`ops-exception:${profile.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many decisions at once. Wait a moment and retry." };

  if (typeof exceptionId !== "string" || !UUID.test(exceptionId)) {
    return { ok: false, error: "That request no longer exists." };
  }
  if (!isExceptionDecision(decision)) return { ok: false, error: "That is not a decision." };
  if (note !== undefined && (typeof note !== "string" || note.length > DECISION_NOTE_MAX)) {
    return { ok: false, error: `Keep the note under ${DECISION_NOTE_MAX} characters.` };
  }

  try {
    const result = await decideException(
      { id: profile.id, role: profile.role === "admin" ? "admin" : "manager" },
      exceptionId,
      decision,
      note,
      { clientActionId: `web:${profile.id}:${exceptionId.toLowerCase()}:${decision}` }
    );
    revalidatePath("/manager");
    revalidatePath("/admin");
    if (result.ok) return { ok: true, orderCancelled: result.orderCancelled };
    switch (result.error) {
      case "not_found":
        return { ok: false, error: "That request no longer exists, or it isn't in your zones." };
      case "note_required":
        return { ok: false, error: "Say why you are rejecting it." };
      case "already_resolved":
        return {
          ok: false,
          error: "Already resolved — someone decided it, or the delivery moved on. It has left the queue.",
        };
      case "photo_required":
        return {
          ok: false,
          error: "The proof-photo rule needs a photo for this, and the rider hasn't attached one. Reject it, or wait for the photo.",
        };
      case "effect_failed":
        return { ok: false, error: effectFailedMessage(result.kind), needsHandling: true };
      default:
        return { ok: false, error: "That decision doesn't apply to this kind of request." };
    }
  } catch (e) {
    if (isRiderSchemaPending(e)) {
      return { ok: false, error: "Rider exceptions need migration 0082 applied." };
    }
    return { ok: false, error: "That didn't go through. Try again." };
  }
}
