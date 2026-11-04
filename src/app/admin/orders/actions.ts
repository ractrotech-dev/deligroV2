"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelOrderAsOps, MIN_CANCEL_REASON } from "@/lib/data-access/order-cancellation";
import { dispatchOrder } from "@/lib/dispatch/rider-dispatch";
import {
  notifyOrderAccepted,
  stopVendorRing,
  notifyOrderReady,
  notifyOnTheWay,
  notifyDelivered,
} from "@/lib/notifications/order-events";
import { vendorRingEnds } from "@/lib/alerts/ring";
import { deferNotify } from "@/lib/notifications/defer";
import { recordCodForStaffDelivery } from "@/lib/data-access/driver-orders";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase to intervene on orders.";
const TOO_MANY = "Too many order changes in a minute. Wait a moment and try again.";

/**
 * The statuses an admin may force an order into.
 *
 * `cancelled` is deliberately absent: cancelling needs a written reason and has
 * to notify the restaurant, so it is its own action rather than a value in this
 * list. Routing it through here would silently skip both.
 */
const OVERRIDABLE = ["placed", "kitchen", "ready", "on_the_way", "delivered"] as const;
type OverridableStatus = (typeof OVERRIDABLE)[number];

function isOverridable(v: string): v is OverridableStatus {
  return (OVERRIDABLE as readonly string[]).includes(v);
}

/** Terminal states — nothing an operator does moves an order back out of these. */
const TERMINAL = new Set(["delivered", "cancelled"]);

function refresh(orderId: string): void {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
}

/**
 * Read the columns an intervention needs to decide what it is allowed to do.
 * Service role, past RLS — authorized by the `requireRole("admin")` in each
 * caller below (AGENTS.md §5).
 */
async function readOrder(orderId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, status, restaurant_id")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Force an order into a different stage.
 *
 * This is the escape hatch for when reality and the database disagree — the
 * kitchen phoned to say the food went out but nobody tapped the button. It is
 * not part of the normal flow, and it does not pretend to be: it writes only
 * `status` and lets `zz_orders_stamp_lifecycle` stamp the matching timestamp,
 * so an overridden order carries the same evidence as one that moved on its own.
 *
 * `accepted_at` / `ready_at` / `cancelled_at` are in `guard_order_update()`'s
 * locked list. Admins are exempt from that guard, which means writing them here
 * would succeed and quietly produce a lifecycle the trigger did not author.
 * That is precisely why this only ever sends `status`.
 */
export async function overrideOrderStatus(
  orderId: string,
  status: string
): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-order-ops:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_MANY };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  if (!isOverridable(status)) {
    return { ok: false, error: "That is not a status an order can be moved to." };
  }

  let current: Awaited<ReturnType<typeof readOrder>>;
  try {
    current = await readOrder(orderId);
  } catch {
    return { ok: false, error: "Could not read that order. Try again." };
  }
  if (!current) return { ok: false, error: "That order no longer exists." };

  if (current.status === status) {
    return { ok: false, error: `This order is already ${status.replace(/_/g, " ")}.` };
  }
  // A delivered or cancelled order is finished. Re-opening one would strand the
  // payment rows that were settled against its final state.
  if (TERMINAL.has(current.status)) {
    return {
      ok: false,
      error: `A ${current.status} order cannot be moved again.`,
    };
  }

  const supabase = createAdminClient();
  // Conditional on the status we just read, so an override decided against
  // stale state cannot clobber a move the kitchen made in the meantime.
  const { data: moved, error } = await supabase
    .from("orders")
    .update({ status })
    .eq("id", orderId)
    .eq("status", current.status)
    .select("id");

  if (error) return { ok: false, error: "That didn't go through. Try again." };
  if (!moved || moved.length === 0) {
    return {
      ok: false,
      error: "This order moved while you were looking at it. Refresh and retry.",
    };
  }

  // Same customer-facing events the vendor and rider paths fire, so an
  // overridden order is not a silent one. Fire-and-forget by contract.
  // Support moved it out of New: the kitchen's phones stop ringing.
  if (vendorRingEnds(current.status, status)) deferNotify(() => stopVendorRing(orderId));
  if (status === "kitchen") deferNotify(() => notifyOrderAccepted(orderId));
  else if (status === "ready") deferNotify(() => notifyOrderReady(orderId));
  else if (status === "on_the_way") deferNotify(() => notifyOnTheWay(orderId));
  else if (status === "delivered") {
    deferNotify(() => notifyDelivered(orderId));
    await recordCodForStaffDelivery(orderId);
  }

  // And the rider, as the vendor path does. An order support pushed to kitchen
  // or ready used to get no dispatch at all: no offer, no rider told, and it
  // sat until somebody happened to open the pool. After the response via
  // after(), which guarantees the offer write finishes.
  if (status === "kitchen") deferNotify(() => dispatchOrder(orderId, "accepted"));
  else if (status === "ready") deferNotify(() => dispatchOrder(orderId, "ready"));

  refresh(orderId);
  return { ok: true };
}

/**
 * Cancel an order, with a written reason (rule book: staff cancel at any time, and
 * the app records who did it and why).
 *
 * The work is `cancelOrderAsOps` (order-cancellation.ts), which an approved
 * failed delivery runs too: one audited RPC (ops_cancel_order, 0191) that cancels
 * and stops the delivery in one transaction. This is the admin console's door to
 * it: the role check, the demo guard, and the operator-facing sentences.
 */
export async function cancelOrderAsAdmin(
  orderId: string,
  reason: string
): Promise<ActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`admin-order-ops:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_MANY };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < MIN_CANCEL_REASON) {
    return { ok: false, error: `Write why you are cancelling (at least ${MIN_CANCEL_REASON} characters).` };
  }

  let result: Awaited<ReturnType<typeof cancelOrderAsOps>>;
  try {
    result = await cancelOrderAsOps(orderId, {
      by: "admin",
      reason: why,
      requestedBy: admin.id,
    });
  } catch {
    return { ok: false, error: "Could not read that order. Try again." };
  }

  if (!result.ok) {
    switch (result.error) {
      case "not_found":
        return { ok: false, error: "That order no longer exists." };
      case "already_cancelled":
        return { ok: false, error: "This order is already cancelled." };
      case "delivered":
        return { ok: false, error: "This order was delivered, so it can't be cancelled." };
      case "stale":
        return { ok: false, error: "This order moved while you were looking at it. Refresh and retry." };
      case "reason_required":
        return { ok: false, error: `Write why you are cancelling (at least ${MIN_CANCEL_REASON} characters).` };
      default:
        return { ok: false, error: "That didn't go through. Try again." };
    }
  }

  refresh(orderId);
  return { ok: true };
}
