"use server";

import { revalidatePath } from "next/cache";
import { statusReason } from "@/lib/vendors/status-reason";
import { requireRole } from "@/lib/auth";
import { approveRestaurant } from "@/lib/data-access/admin-stats";
import { decideRefund, releaseRefundClaim } from "@/lib/data-access/refunds";
import type { RefundDecisionError } from "@/lib/data-access/refunds";
import { notifyRefundDecided } from "@/lib/notifications/order-events";
import { rateLimit } from "@/lib/rate-limit";
import { deferNotify } from "@/lib/notifications/defer";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Non-blocking: the action succeeded, but there's something to know about it. */
  warning?: string;
  /** The machine-readable outcome, where the screen acts on it. */
  code?: string;
}

/**
 * Release a refund whose Razorpay outcome was never heard, after the admin has
 * checked the dashboard and seen nothing was sent. Audited with the reason.
 */
export async function releaseRefundClaimAction(id: string, reason: string): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Write what you checked (at least 3 characters)." };
  const result = await releaseRefundClaim({ id: admin.id }, id, why).catch(() => null);
  if (!result) return { ok: false, error: "Couldn't release it. Try again." };
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "gateway_paid"
          ? "Razorpay already returned this money, so it can't be released. Approve it to record that."
          : result.error === "reason_required"
            ? "Write what you checked (3–300 characters)."
            : "Your session expired. Sign in and try again.",
    };
  }
  revalidatePath("/admin/refunds");
  return { ok: true };
}

/**
 * Real admin decisions. These exist because the buttons that used to sit on
 * these screens called nothing at all — the refund "Approve" only set local
 * React state and then rendered "Approved · logged".
 *
 * `requireRole` gates the call, and RLS gates the write, so neither one alone is
 * load-bearing.
 */
export async function approveRestaurantAction(id: string, reason: string): Promise<ActionResult> {
  await requireRole("admin");
  const why = statusReason(reason);
  if (!why) return { ok: false, error: "Give a reason (at least 3 characters)." };

  try {
    await approveRestaurant(id, why);
  } catch (err) {
    // The map-pin check explains itself; anything else is a retry.
    const message = err instanceof Error && /pin/i.test(err.message) ? err.message : "Couldn't approve. Try again.";
    return { ok: false, error: message };
  }

  // The storefront is now live — the customer feed must be rebuilt.
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Approve or deny a refund.
 *
 * `denied` is the database's word for it — `refund_status` is
 * ('pending','approved','denied'). This action used to send 'rejected', which
 * the enum has never accepted, so every deny failed at Postgres while the screen
 * rendered the decision as recorded. Approve worked; deny was theatre.
 *
 * Approving an online-paid order returns the money through Razorpay inside
 * `decideRefund`. When the gateway refuses, the request stays pending and the
 * admin is told exactly that — the one thing this must never do is report money
 * returned that wasn't.
 */
export async function decideRefundAction(
  id: string,
  decision: "approved" | "denied",
  reason: string
): Promise<ActionResult> {
  const admin = await requireRole("admin");

  // The ordinary write ceiling, keyed on the admin (checklist §4). The
  // one-gateway-call-per-refund claim (the double-refund guard) lives inside
  // decideRefund and the database, so managers deciding refunds get it too.
  const limit = await rateLimit(`refund-decide-admin:${admin.id}`, 60, 60_000);
  if (!limit.ok) {
    return { ok: false, error: "Too many decisions at once. Slow down." };
  }

  // A throw here means the write itself broke — decideRefund answers every
  // outcome it can describe with a result instead.
  const result = await decideRefund({ id: admin.id }, id, decision, reason).catch(() => null);
  if (!result) {
    return { ok: false, error: "Couldn't record the decision. Try again." };
  }

  if (!result.ok) {
    return { ok: false, error: DECISION_ERRORS[result.error], code: result.error };
  }

  // Fire-and-forget: order-events never throws, and a push outage must not
  // undo a decision that has already been written (and, on an online order,
  // already been paid out).
  deferNotify(() => notifyRefundDecided(result.orderId, result.approved));

  revalidatePath("/admin/refunds");
  revalidatePath("/admin");
  revalidatePath("/admin/settlements");
  return { ok: true, warning: result.settlementWarning ?? undefined };
}

/**
 * What the admin is told. Each of these is a different instruction, so none of
 * them collapses into "try again" — the gateway cases in particular decide
 * whether retrying is safe.
 */
const DECISION_ERRORS: Record<RefundDecisionError, string> = {
  unauthorized: "Your session expired. Sign in and try again.",
  not_pending: "This refund has already been decided.",
  in_progress:
    "That refund is being processed by someone else, or an earlier attempt got no answer from Razorpay. Check the Razorpay dashboard; if nothing was sent, release it from the refund's row and decide again.",
  reason_required: "Write a short reason for the decision (3–300 characters).",
  amount_exceeds_payment:
    "The refund is larger than the payment we captured. Check the order before approving.",
  gateway_failed:
    "The gateway didn't complete the refund. Nothing was returned and the request is still pending.",
  gateway_unknown:
    "Razorpay didn't answer, so we can't tell whether the money went. Don't approve again: check the Razorpay dashboard first, then release this refund (if nothing was sent) or record it.",
  gateway_paid: "Razorpay already returned this money. Approve it to record that — it can't be denied.",
  recorded_failed_after_gateway:
    "The money WAS refunded but couldn't be recorded at all. Don't approve again — tell the admin team so it can be reconciled.",
  record_failed:
    "The money WAS refunded but the decision didn't save. Approving again is safe: it records the refund without sending money twice.",
};
