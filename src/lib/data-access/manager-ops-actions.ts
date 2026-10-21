import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { vendorRingEnds } from "@/lib/alerts/ring";
import { recordCodForStaffDelivery } from "@/lib/data-access/driver-orders";
import { cancelOrderCore } from "@/lib/data-access/order-cancellation";
import { dispatchOrder } from "@/lib/dispatch/rider-dispatch";
import { deferNotify } from "@/lib/notifications/defer";
import {
  notifyDelivered,
  notifyDriverAssigned,
  notifyDriverReassignedAway,
  notifyOnTheWay,
  notifyOrderAccepted,
  notifyOrderReady,
  notifyVendorRiderAssigned,
  notifyVendorRiderChanged,
  notifyOpsEmergency,
  stopRiderRing,
  stopVendorRing,
} from "@/lib/notifications/order-events";
import { mapRpcError, type CorrectionKind, type OpsResult } from "@/lib/ops/order-actions";
import type { DbOrderStatus } from "@/lib/ops/order-contract";

export { mapRpcError, type OpsResult } from "@/lib/ops/order-actions";
export { listRiderCandidates } from "@/lib/data-access/manager-rider-candidates";
import { readOrderFacts, type OrderFacts } from "@/lib/data-access/manager-rider-candidates";

/**
 * Manager order interventions (§3.14–3.16, §6.9–6.10). Each calls its 0142/0143
 * RPC with the service role — the RPC re-checks the actor's zone, changes the
 * order and writes the ops_audit_log row in one transaction — then runs the
 * same side effects the web actions always have (pushes, ring stop, dispatch,
 * COD record), after the response, through deferNotify.
 *
 * Callers authorise first (managerApiContext + the action's switch, or
 * requireRole for the web portals). Each function also reads the order through
 * the actor's own scope before doing anything outside the RPC, so a side effect
 * (a queued refund, a push) can never happen for an order the actor cannot see.
 */
export type OpsActor = { id: string; role: "manager" | "admin" };

interface RpcError { code?: string; message?: string; details?: string | null }

const NOT_FOUND: OpsResult = { ok: false, status: 404, error: "not_found" };

/** The order as the actor's scope sees it, or null (missing and out of scope alike). */
async function scopedOrder(actor: OpsActor, orderId: string): Promise<OrderFacts | null> {
  const scope = await staffScopeFor(actor);
  return readOrderFacts(scope, orderId);
}


/**
 * Call an intervention RPC. `replayed` is the RPC's own answer — it claims the
 * client action id inside the transaction that does the work, under the order
 * row lock — so two concurrent sends of one tap fire their side effects once.
 */
async function rpc(
  name: string,
  args: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; replayed: boolean; error: RpcError | null }> {
  const { data, error } = await createAdminClient().rpc(name, args);
  const row = (data ?? null) as Record<string, unknown> | null;
  return { data: row, replayed: row?.replayed === true, error: error as RpcError | null };
}

async function riderName(riderId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("full_name").eq("id", riderId).maybeSingle();
  return (data as { full_name: string | null } | null)?.full_name ?? null;
}

/** A rider who was offered this order and is not the one now on it stops ringing. */
function stopStaleOffer(orderId: string, offered: string | null | undefined, nowOn: string): void {
  if (offered && offered !== nowOn) deferNotify(() => stopRiderRing(offered, orderId));
}

function advanceEffects(orderId: string, from: DbOrderStatus, to: DbOrderStatus): void {
  if (vendorRingEnds(from, to)) deferNotify(() => stopVendorRing(orderId));
  if (to === "kitchen") {
    deferNotify(() => notifyOrderAccepted(orderId));
    deferNotify(() => dispatchOrder(orderId, "accepted"));
  } else if (to === "ready") {
    deferNotify(() => notifyOrderReady(orderId));
    deferNotify(() => dispatchOrder(orderId, "ready"));
  } else if (to === "on_the_way") {
    deferNotify(() => notifyOnTheWay(orderId));
  } else if (to === "delivered") {
    deferNotify(() => notifyDelivered(orderId));
    deferNotify(() => recordCodForStaffDelivery(orderId));
  }
}

const NEXT: Partial<Record<DbOrderStatus, DbOrderStatus>> = {
  placed: "kitchen", kitchen: "ready", ready: "on_the_way", on_the_way: "delivered",
};

export async function opsAdvance(
  actor: OpsActor, orderId: string, expected: DbOrderStatus, reason: string, clientActionId: string
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const { error, replayed } = await rpc("ops_advance_order", {
    p_actor: actor.id, p_order: orderId, p_expected: expected, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  const to = NEXT[expected];
  if (!replayed && to) advanceEffects(orderId, expected, to);
  return { ok: true };
}

export async function opsCancel(actor: OpsActor, orderId: string, reason: string, clientActionId: string): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const result = await cancelOrderCore(actor, order.id, reason, clientActionId);
  return result.ok ? { ok: true } : result.result;
}

export async function opsAssign(
  actor: OpsActor, orderId: string, riderId: string, reason: string | null, clientActionId: string, override = false
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const { error, replayed } = await rpc("ops_assign_rider", {
    p_actor: actor.id, p_order: orderId, p_rider: riderId, p_reason: reason,
    p_client_action_id: clientActionId, p_override: override,
  });
  if (error) return mapRpcError(error);
  if (!replayed) {
    stopStaleOffer(orderId, order.delivery?.offeredDriverId, riderId);
    deferNotify(async () => {
      const name = await riderName(riderId);
      await Promise.all([
        notifyDriverAssigned(riderId, { orderId, restaurantName: order.restaurantName }),
        notifyVendorRiderAssigned(orderId, name),
      ]);
    });
  }
  return { ok: true };
}

export async function opsReassign(
  actor: OpsActor, orderId: string, riderId: string, reason: string, afterPickup: boolean, clientActionId: string,
  override = false
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const previous = order.delivery?.driverId ?? null;
  const pickedUp = order.delivery?.status === "picked_up";
  const stillCarrying = order.delivery?.status === "assigned" || pickedUp;
  const { error, replayed } = await rpc("ops_reassign_delivery", {
    p_actor: actor.id, p_order: orderId, p_rider: riderId, p_reason: reason,
    p_after_pickup: afterPickup, p_client_action_id: clientActionId, p_override: override,
  });
  if (error) return mapRpcError(error);
  if (!replayed) {
    stopStaleOffer(orderId, order.delivery?.offeredDriverId, riderId);
    deferNotify(async () => {
      const name = await riderName(riderId);
      await Promise.all([
        notifyDriverAssigned(riderId, { orderId, restaurantName: order.restaurantName }),
        previous && stillCarrying && previous !== riderId
          ? notifyDriverReassignedAway(previous, { orderId, pickedUp })
          : Promise.resolve(),
        notifyVendorRiderChanged(orderId, name),
      ]);
    });
  }
  return { ok: true };
}

export async function opsEscalate(
  actor: OpsActor, orderId: string, reason: string, priority: "high" | "emergency", clientActionId: string
): Promise<OpsResult & { ticket?: { id: string; number: number } }> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const { data, error, replayed } = await rpc("ops_escalate_order", {
    p_actor: actor.id, p_order: orderId, p_reason: reason, p_priority: priority, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  const t = data as { ticket_id?: string; number?: number | string } | null;
  // Emergency: the zone's managers and every admin get an urgent push, once.
  if (!replayed && priority === "emergency") {
    deferNotify(() => notifyOpsEmergency(orderId, { zoneId: order.zoneId, restaurantName: order.restaurantName, reason }));
  }
  return { ok: true, ...(t?.ticket_id ? { ticket: { id: t.ticket_id, number: Number(t.number) } } : {}) };
}

export async function opsCorrect(
  actor: OpsActor,
  orderId: string,
  input: { kind: CorrectionKind; toStatus?: string; itemId?: string; note?: string },
  reason: string,
  clientActionId: string
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const { error, replayed } = await rpc("ops_correct_order", {
    p_actor: actor.id, p_order: orderId, p_kind: input.kind, p_to_status: input.toStatus ?? null,
    p_item: input.itemId ?? null, p_reason: reason, p_client_action_id: clientActionId, p_note: input.note ?? null,
  });
  if (error) return mapRpcError(error);
  // Put back to `ready` with nobody on it: offer it, as the kitchen's own move would.
  const riderless = !order.delivery?.driverId || order.delivery.status === "unassigned" || order.delivery.status === "cancelled";
  if (!replayed && input.kind === "status" && input.toStatus === "ready" && riderless) {
    deferNotify(() => dispatchOrder(orderId, "ready"));
  }
  return { ok: true };
}

export async function opsNote(actor: OpsActor, orderId: string, note: string, clientActionId: string): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const { error } = await rpc("ops_add_order_note", {
    p_actor: actor.id, p_order: orderId, p_note: note, p_client_action_id: clientActionId,
  });
  return error ? mapRpcError(error) : { ok: true };
}

