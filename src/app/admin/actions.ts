"use server";

import { revalidatePath } from "next/cache";
import { statusReason } from "@/lib/vendors/status-reason";
import { requireRole } from "@/lib/auth";
import { approveRestaurant } from "@/lib/data-access/admin-stats";
import { decideRefund } from "@/lib/data-access/refunds";
import type { RefundDecisionError } from "@/lib/data-access/refunds";
import { notifyRefundDecided } from "@/lib/notifications/order-events";
import { rateLimit } from "@/lib/rate-limit";
import { deferNotify } from "@/lib/notifications/defer";

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Non-blocking: the action succeeded, but there's something to know about it. */
  warning?: string;
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
  decision: "approved" | "denied"
): Promise<ActionResult> {
  const admin = await requireRole("admin");

  // Two buckets, because they stop different things.
  //
  // The per-refund one is the important one: `decideRefund` reads the row as
  // pending, calls Razorpay, and only then writes. Two approvals landing inside
  // that window would both find it pending and both refund — a double-click, an
  // impatient retry or a second admin on the same queue is enough. Postgres has
  // no in-between status to claim, so a one-per-refund window is the lock, and
  // it deliberately outlasts a gateway call: a retry after a failed refund is a
  // decision to make slowly.
  const once = await rateLimit(`refund-decide:${id}`, 1, 15_000);
  if (!once.ok) {
    return {
      ok: false,
      error: "That refund is already being decided. Give it a moment.",
    };
  }

  // And the ordinary write ceiling, keyed on the admin (checklist §4).
  const limit = await rateLimit(`refund-decide-admin:${admin.id}`, 60, 60_000);
  if (!limit.ok) {
    return { ok: false, error: "Too many decisions at once. Slow down." };
  }

  // A throw here means the write itself broke — decideRefund answers every
  // outcome it can describe with a result instead.
  const result = await decideRefund(id, decision).catch(() => null);
  if (!result) {
    return { ok: false, error: "Couldn't record the decision. Try again." };
  }

  if (!result.ok) {
    return { ok: false, error: DECISION_ERRORS[result.error] };
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
  amount_exceeds_payment:
    "The refund is larger than the payment we captured. Check the order before approving.",
  gateway_failed:
    "The gateway didn't complete the refund. Nothing was returned and the request is still pending.",
  record_failed:
    "The money WAS refunded but the decision couldn't be saved. Don't approve again — check the order first.",
};
