import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { staffScopeFor } from "@/lib/auth/manager-api.server";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
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
  stopVendorRing,
} from "@/lib/notifications/order-events";
import { riderPhase } from "@/lib/rider/availability";
import { rankCandidates, riderEligibility } from "@/lib/ops/live-rules";
import { mapRpcError, type OpsResult } from "@/lib/ops/order-actions";
import type { DbOrderStatus, RiderCandidate } from "@/lib/ops/order-contract";

export { mapRpcError, type OpsResult } from "@/lib/ops/order-actions";

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

interface OrderFacts {
  id: string;
  status: DbOrderStatus;
  restaurantId: string;
  restaurantName: string;
  zoneId: string | null;
  delivery: { status: string; driverId: string | null } | null;
}

/** The order as the actor's scope sees it, or null (missing and out of scope alike). */
async function scopedOrder(actor: OpsActor, orderId: string): Promise<OrderFacts | null> {
  const scope = await staffScopeFor(actor);
  return readOrderFacts(scope, orderId);
}

async function readOrderFacts(scope: ManagerScope, orderId: string): Promise<OrderFacts | null> {
  const supabase = createAdminClient();
  let query = supabase
    .from("orders")
    .select("id, status, restaurant_id, zone_id, restaurants(name), deliveries(status, driver_id)")
    .eq("id", orderId);
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  const { data } = await query.maybeSingle();
  if (!data) return null;
  const r = data as unknown as {
    id: string; status: DbOrderStatus; restaurant_id: string; zone_id: string | null;
    restaurants: { name: string | null } | { name: string | null }[] | null;
    deliveries: { status: string; driver_id: string | null } | { status: string; driver_id: string | null }[] | null;
  };
  const shop = Array.isArray(r.restaurants) ? r.restaurants[0] : r.restaurants;
  const d = Array.isArray(r.deliveries) ? r.deliveries[0] : r.deliveries;
  return {
    id: r.id,
    status: r.status,
    restaurantId: r.restaurant_id,
    restaurantName: shop?.name?.trim() || "the restaurant",
    zoneId: r.zone_id,
    delivery: d ? { status: d.status, driverId: d.driver_id } : null,
  };
}

/** Has this actor already done this client action? (Their own id → a replay.) */
async function alreadyDone(actorId: string, clientActionId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("ops_audit_log")
    .select("actor_id")
    .eq("client_action_id", clientActionId)
    .maybeSingle();
  return !!data && (data as { actor_id: string }).actor_id === actorId;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
  const { data, error } = await createAdminClient().rpc(name, args);
  return { data, error: error as RpcError | null };
}

async function riderName(riderId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("profiles").select("full_name").eq("id", riderId).maybeSingle();
  return (data as { full_name: string | null } | null)?.full_name ?? null;
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
  actor: OpsActor, orderId: string, expected: DbOrderStatus, reason: string | null, clientActionId: string
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await rpc("ops_advance_order", {
    p_actor: actor.id, p_order: orderId, p_expected: expected, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  const to = NEXT[expected];
  if (!replay && to) advanceEffects(orderId, expected, to);
  return { ok: true };
}

export async function opsCancel(actor: OpsActor, orderId: string, reason: string, clientActionId: string): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const result = await cancelOrderCore(actor, order.id, reason, clientActionId);
  return result.ok ? { ok: true } : result.result;
}

export async function opsAssign(
  actor: OpsActor, orderId: string, riderId: string, reason: string | null, clientActionId: string
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await rpc("ops_assign_rider", {
    p_actor: actor.id, p_order: orderId, p_rider: riderId, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  if (!replay) {
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
  actor: OpsActor, orderId: string, riderId: string, reason: string, afterPickup: boolean, clientActionId: string
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const previous = order.delivery?.driverId ?? null;
  const pickedUp = order.delivery?.status === "picked_up";
  const { error } = await rpc("ops_reassign_delivery", {
    p_actor: actor.id, p_order: orderId, p_rider: riderId, p_reason: reason,
    p_after_pickup: afterPickup, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  if (!replay) {
    deferNotify(async () => {
      const name = await riderName(riderId);
      await Promise.all([
        notifyDriverAssigned(riderId, { orderId, restaurantName: order.restaurantName }),
        previous ? notifyDriverReassignedAway(previous, { orderId, pickedUp }) : Promise.resolve(),
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
  const { data, error } = await rpc("ops_escalate_order", {
    p_actor: actor.id, p_order: orderId, p_reason: reason, p_priority: priority, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  const t = data as { ticket_id: string; number: number | string } | null;
  return { ok: true, ...(t?.ticket_id ? { ticket: { id: t.ticket_id, number: Number(t.number) } } : {}) };
}

export async function opsCorrect(
  actor: OpsActor,
  orderId: string,
  input: { kind: "status" | "delivery_status" | "item_unavailable"; toStatus?: string; itemId?: string },
  reason: string,
  clientActionId: string
): Promise<OpsResult> {
  const order = await scopedOrder(actor, orderId);
  if (!order) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await rpc("ops_correct_order", {
    p_actor: actor.id, p_order: orderId, p_kind: input.kind, p_to_status: input.toStatus ?? null,
    p_item: input.itemId ?? null, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapRpcError(error);
  // Put back to `ready` with nobody on it: offer it, as the kitchen's own move would.
  const riderless = !order.delivery?.driverId || order.delivery.status === "unassigned" || order.delivery.status === "cancelled";
  if (!replay && input.kind === "status" && input.toStatus === "ready" && riderless) {
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

/**
 * Riders a manager may put on this order, eligible first. Riders who share a
 * zone with the manager's scope are listed (admins: every rider), each with the
 * reason they cannot take it when they cannot. Null when the order is missing
 * or out of scope.
 */
export async function listRiderCandidates(scope: ManagerScope, orderId: string, now: Date): Promise<RiderCandidate[] | null> {
  const order = await readOrderFacts(scope, orderId);
  if (!order) return null;
  const supabase = createAdminClient();

  const { data: shopRow } = await supabase.from("restaurants").select("lat, lng").eq("id", order.restaurantId).maybeSingle();
  const shop = shopRow as { lat: number | null; lng: number | null } | null;

  const zones = scopeZoneIds(scope);
  let staff = supabase.from("staff_zones").select("user_id, zone_id");
  if (zones) staff = staff.in("zone_id", zones as string[]);
  const { data: staffRows, error: staffErr } = await staff;
  if (staffErr) throw staffErr;
  const zonesOf = new Map<string, string[]>();
  for (const s of (staffRows ?? []) as { user_id: string; zone_id: string }[]) {
    zonesOf.set(s.user_id, [...(zonesOf.get(s.user_id) ?? []), s.zone_id]);
  }

  // A rider's full zone list decides eligibility, not just the zones the
  // manager shares with them; read it for the riders found above.
  const { data: people, error: pErr } = await supabase
    .from("profiles").select("id, full_name").eq("role", "driver").in("id", [...zonesOf.keys()].length ? [...zonesOf.keys()] : ["00000000-0000-0000-0000-000000000000"]);
  if (pErr) throw pErr;
  const riders = (people ?? []) as { id: string; full_name: string | null }[];
  if (riders.length === 0) return [];
  const ids = riders.map((r) => r.id);

  const [{ data: allZones }, { data: statuses }, { data: codes }, { data: loads }] = await Promise.all([
    supabase.from("staff_zones").select("user_id, zone_id").in("user_id", ids),
    supabase.from("rider_status").select("driver_id, is_online, break_until, last_lat, last_lng, last_fix_at").in("driver_id", ids),
    supabase.from("rider_profiles").select("driver_id, rider_code").in("driver_id", ids),
    supabase.from("deliveries").select("driver_id").in("driver_id", ids).in("status", ["assigned", "picked_up"]),
  ]);
  const riderZones = new Map<string, string[]>();
  for (const z of (allZones ?? []) as { user_id: string; zone_id: string }[]) {
    riderZones.set(z.user_id, [...(riderZones.get(z.user_id) ?? []), z.zone_id]);
  }
  type St = { driver_id: string; is_online: boolean; break_until: string | null; last_lat: number | null; last_lng: number | null; last_fix_at: string | null };
  const statusOf = new Map(((statuses ?? []) as St[]).map((s) => [s.driver_id, s]));
  const codeOf = new Map(((codes ?? []) as { driver_id: string; rider_code: string | null }[]).map((c) => [c.driver_id, c.rider_code]));
  const loadOf = new Map<string, number>();
  for (const l of (loads ?? []) as { driver_id: string }[]) loadOf.set(l.driver_id, (loadOf.get(l.driver_id) ?? 0) + 1);

  const current = order.delivery && ["assigned", "picked_up"].includes(order.delivery.status) ? order.delivery.driverId : null;
  const shopPoint = shop?.lat != null && shop?.lng != null ? { lat: shop.lat, lng: shop.lng } : null;

  const list: RiderCandidate[] = riders.map((r) => {
    const st = statusOf.get(r.id);
    const facts = {
      id: r.id,
      isOnline: st?.is_online ?? false,
      breakUntil: st?.break_until ?? null,
      lastFixAt: st?.last_fix_at ?? null,
      lat: st?.last_lat ?? null,
      lng: st?.last_lng ?? null,
      zoneIds: riderZones.get(r.id) ?? [],
      // profiles.account_status arrives in Phase 5; until then nobody is suspended.
      suspended: false,
      activeDeliveries: loadOf.get(r.id) ?? 0,
    };
    const e = riderEligibility(facts, { orderZoneId: order.zoneId ?? "", currentRiderId: current, shop: shopPoint }, now);
    const fixMs = facts.lastFixAt ? Date.parse(facts.lastFixAt) : NaN;
    return {
      id: r.id,
      name: r.full_name?.trim() || "Rider",
      code: codeOf.get(r.id) ?? null,
      phase: riderPhase({ isOnline: facts.isOnline, breakUntil: facts.breakUntil, onlineSince: null, lastFixAt: facts.lastFixAt }, now),
      activeDeliveries: facts.activeDeliveries,
      distanceKm: e.distanceKm,
      lastFixAgeSeconds: Number.isFinite(fixMs) ? Math.max(0, Math.floor((now.getTime() - fixMs) / 1000)) : null,
      eligible: e.eligible,
      ineligibleReason: e.ineligibleReason,
    };
  });
  return rankCandidates(list);
}
