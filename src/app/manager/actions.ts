"use server";

import { revalidatePath } from "next/cache";
import { staffFeatureOn } from "@/lib/features/guards.server";
import { FEATURE_OFF_MESSAGE } from "@/lib/features/catalog";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  notifyOrderAccepted,
  stopVendorRing,
  notifyOrderReady,
  notifyOnTheWay,
  notifyDelivered,
  notifyDriverAssigned,
  notifyOffereeOfHandAssignment,
  notifyVendorRiderAssigned,
} from "@/lib/notifications/order-events";
import { vendorRingEnds } from "@/lib/alerts/ring";
import { dispatchOrder } from "@/lib/dispatch/rider-dispatch";
import { recordCodForStaffDelivery } from "@/lib/data-access/driver-orders";
import { columnKnownMissing, isMissingColumn, rememberColumn } from "@/lib/data-access/schema-probe";
import { deferNotify } from "@/lib/notifications/defer";
import { rateLimit } from "@/lib/rate-limit";
import {
  decideException,
  listPendingExceptions,
  type OpsException,
} from "@/lib/data-access/delivery-exceptions";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { isExceptionDecision } from "@/lib/rider/exception-rules";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase and apply 0023 to work orders.";
const LOCATION_SOURCE_COLUMN = "deliveries.driver_location_source";

/**
 * The linear pipeline, and the only moves a manager may make along it.
 *
 * Forward-only, one step at a time. A manager is an operator, not an auditor:
 * the ability to drag an order backwards, or to jump it from `placed` straight
 * to `delivered`, is an admin override and lives on the admin order screen
 * behind `requireRole("admin")`.
 */
const NEXT: Record<string, string> = {
  placed: "kitchen",
  kitchen: "ready",
  ready: "on_the_way",
  on_the_way: "delivered",
};

/**
 * Advance one order to the next stage.
 *
 * Two things make this its own action rather than a call into the vendor route:
 *
 *   * `/api/orders/[id]/status` is restaurant-only by design — it authorizes on
 *     ownership of the restaurant, which a manager does not have.
 *   * `guard_order_update()` lets a non-admin change **only** `status` on an
 *     order. Every other column is locked, and the check is per-column across
 *     the whole row: send `status` plus anything else — a timestamp, an
 *     `updated_at` — and Postgres rejects the entire update. So this sends one
 *     field and lets `zz_orders_stamp_lifecycle` do the rest.
 */
export async function advanceOrder(
  orderId: string,
  expected: string
): Promise<ActionResult> {
  // ["manager", "admin"] matches the /manager layout, which admits both. This
  // grants an admin nothing new — RLS is the real boundary and `is_admin()`
  // already passes it — it just stops the portal's own buttons from bouncing
  // the admin the layout let in.
  await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.move_status"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  const target = NEXT[expected];
  if (!target) {
    return { ok: false, error: "This order has nowhere further to go." };
  }

  const supabase = await createClient();

  // Conditional on the status the manager was looking at. Two managers working
  // the same board would otherwise both advance the same order and push it two
  // stages in one tap — the second update matches zero rows instead.
  const { data, error } = await supabase
    .from("orders")
    .update({ status: target })
    .eq("id", orderId)
    .eq("status", expected)
    .select("id");

  if (error) return { ok: false, error: "That didn't go through. Try again." };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Someone else moved this order. Refresh to see where it is.",
    };
  }

  // A manager moved it out of New: the kitchen's phones stop ringing.
  if (vendorRingEnds(expected, target)) deferNotify(() => stopVendorRing(orderId));
  if (target === "kitchen") deferNotify(() => notifyOrderAccepted(orderId));
  else if (target === "ready") deferNotify(() => notifyOrderReady(orderId));
  else if (target === "on_the_way") deferNotify(() => notifyOnTheWay(orderId));
  else if (target === "delivered") {
    deferNotify(() => notifyDelivered(orderId));
    await recordCodForStaffDelivery(orderId);
  }

  // Dispatch, exactly as when the kitchen makes the same move — see
  // announceKitchenTransition in vendor-orders.ts. Without it an order a
  // manager advanced was offered to no rider.
  if (target === "kitchen") deferNotify(() => dispatchOrder(orderId, "accepted"));
  else if (target === "ready") deferNotify(() => dispatchOrder(orderId, "ready"));

  revalidatePath("/manager");
  return { ok: true };
}

/**
 * Hand a ready order to a specific rider.
 *
 * The race handling is copied from `acceptDelivery()` in driver-orders.ts, and
 * for the same reason: `deliveries.order_id` is unique (0001), so when a manager
 * dispatches an order at the moment a rider self-assigns it, both pass the
 * pre-check and the loser's insert raises 23505. That is not an error to show as
 * a failure — someone got there first, and the job is covered either way.
 */
export async function assignRider(
  orderId: string,
  riderId: string
): Promise<ActionResult> {
  await requireRole(["manager", "admin"]);
  if (!(await staffFeatureOn("manager.assign_rider"))) return { ok: false, error: FEATURE_OFF_MESSAGE };
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  if (!orderId || !riderId) {
    return { ok: false, error: "Pick a rider first." };
  }

  const supabase = await createClient();

  // Read the row whatever its status. It used to filter to the claimed
  // statuses, which was correct only while `deliveries` rows came into being at
  // the moment a rider accepted. Dispatch (0042) now leaves an `unassigned` row
  // carrying an offer, and the insert below would hit the unique constraint on
  // `order_id` and tell the manager "a rider took this order first" about an
  // order no rider had touched.
  const { data: existing } = await supabase
    .from("deliveries")
    .select("id, status")
    .eq("order_id", orderId)
    .maybeSingle();

  if (existing && existing.status !== "unassigned") {
    return { ok: false, error: "This order already has a rider." };
  }

  // No coordinates, and `driver_location_source: 'none'` says so out loud. The
  // tracking map draws an estimate until the rider's device reports a real fix
  // — seeding a fake position here is the exact bug slice D removed.
  const claim = {
    driver_id: riderId,
    status: "assigned" as const,
    assigned_at: new Date().toISOString(),
  };

  // A manager assigning deliberately OVERRIDES whatever dispatch offered: they
  // can see the board and the rider in front of them, and the automatic pick
  // cannot. `offered_driver_id` is left alone — it is the record of who the
  // system asked, which stays true whether or not that is who was sent. Neither
  // the claim nor `guard_delivery_transition` clears it (only a release does),
  // so the claimed row's own value names the rider dispatch's offer was out to
  // at the moment of the claim — read in the same statement, no race with a
  // re-offer between a separate read and the write.
  const write = (withSource: boolean) =>
    existing
      ? supabase
          .from("deliveries")
          .update({
            ...claim,
            ...(withSource ? { driver_location_source: "none" } : {}),
          })
          .eq("id", existing.id)
          // The optimistic lock the insert path gets for free from the unique
          // constraint: if a rider accepted the offer between our read and this
          // write, no row matches and we say so rather than reporting a
          // dispatch that never happened.
          .eq("status", "unassigned")
          .select("id, offered_driver_id")
      : supabase
          .from("deliveries")
          .insert({
            order_id: orderId,
            ...claim,
            ...(withSource ? { driver_location_source: "none" } : {}),
          })
          .select("id, offered_driver_id");

  const withSource = !columnKnownMissing(LOCATION_SOURCE_COLUMN);
  let { data, error } = await write(withSource);

  if (error && withSource && isMissingColumn(error)) {
    rememberColumn(LOCATION_SOURCE_COLUMN, false);
    ({ data, error } = await write(false));
  } else if (!error && withSource) {
    rememberColumn(LOCATION_SOURCE_COLUMN, true);
  }

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, error: "A rider took this order first." };
    }
    return { ok: false, error: "That didn't go through. Try again." };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "A rider took this order first." };
  }
  // The claimed row's offeree (see above): that rider stops ringing and, if
  // the order went to someone else, is told (`notifyOffereeOfHandAssignment`).
  const offeredDriverId =
    (data?.[0] as { offered_driver_id?: string | null } | undefined)?.offered_driver_id ?? null;

  // Tell the rider they have a job, and the kitchen who is coming for it.
  // Assignment used to be silent: the rider learned of it on their next board
  // refresh, which with the phone in a pocket meant whenever they next looked.
  // Service-role reads, after the response: the cookie-bound client is not
  // safe to use once the request has finished, and requireRole() above is the
  // authorization for this path (AGENTS.md rule 5).
  deferNotify(async () => {
    const admin = createAdminClient();
    const { data: order } = await admin
      .from("orders")
      .select("restaurants(name)")
      .eq("id", orderId)
      .maybeSingle();
    const shop = order?.restaurants as { name: string | null } | { name: string | null }[] | null;
    const restaurantName =
      (Array.isArray(shop) ? shop[0]?.name : shop?.name)?.trim() || "the restaurant";
    const { data: rider } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", riderId)
      .maybeSingle();
    await Promise.all([
      notifyOffereeOfHandAssignment(orderId, { offeredDriverId, assignedRiderId: riderId }),
      notifyDriverAssigned(riderId, { orderId, restaurantName }),
      notifyVendorRiderAssigned(orderId, rider?.full_name ?? null),
    ]);
  });

  revalidatePath("/manager");
  return { ok: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISION_NOTE_MAX = 300;

/**
 * The "Needs a decision" queue, for a board that polls rather than refreshes
 * (the admin home). Read-only. The rider's phone is dropped unless this
 * operator may call (`manager.call_customer`; an admin always may) — hiding
 * the Call link alone would still ship the number.
 */
export async function listExceptionQueue(): Promise<OpsException[]> {
  await requireRole(["manager", "admin"]);
  if (!isSupabaseConfigured) return [];
  const [items, canCall] = await Promise.all([
    listPendingExceptions(),
    staffFeatureOn("manager.call_customer"),
  ]);
  return canCall ? items : items.map((x) => ({ ...x, riderPhone: null }));
}

/**
 * The approval was recorded (decisions are final) but what it should have done
 * failed part-way. The operator has to finish it by hand; say exactly what.
 */
function effectFailedMessage(kind: string | undefined): string {
  const lead = "Approved, but the change didn't go through — ";
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
 * every write (AGENTS.md rule 6).
 */
export async function decideExceptionAction(
  exceptionId: string,
  decision: string,
  note?: string
): Promise<DecideExceptionActionResult> {
  const profile = await requireRole(["manager", "admin"]);
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
      note
    );
    revalidatePath("/manager");
    revalidatePath("/admin");
    if (result.ok) return { ok: true, orderCancelled: result.orderCancelled };
    switch (result.error) {
      case "not_found":
        return { ok: false, error: "That request no longer exists." };
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
