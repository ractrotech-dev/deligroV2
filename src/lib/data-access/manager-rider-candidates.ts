import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { loadWorkBlocks } from "@/lib/data-access/rider-work";
import { readAllRows } from "@/lib/data-access/read-all";
import { readByIds } from "@/lib/data-access/scoped-riders";
import { rankCandidates } from "@/lib/ops/live-rules";
import { toRiderCandidate } from "@/lib/ops/rider-candidate";
import type { DbOrderStatus, RiderCandidate } from "@/lib/ops/order-contract";

/**
 * Reads behind the order actions: the order as a scope sees it, and the riders
 * who could take it. Kept apart from manager-ops-actions so a reader (or a QA
 * script) can use them without the push and dispatch side-effect modules.
 *
 * Every rider read is paged or chunked: a zone can hold more riders than one
 * PostgREST read returns or one URL can carry.
 *
 * Callers authorise first (AGENTS.md rule 5).
 */

export interface OrderFacts {
  id: string;
  status: DbOrderStatus;
  restaurantId: string;
  restaurantName: string;
  zoneId: string | null;
  delivery: { status: string; driverId: string | null; offeredDriverId: string | null } | null;
}

/** The order as `scope` sees it, or null (missing and out of scope alike). */
export async function readOrderFacts(scope: ManagerScope, orderId: string): Promise<OrderFacts | null> {
  const supabase = createAdminClient();
  let query = supabase
    .from("orders")
    .select("id, status, restaurant_id, zone_id, restaurants(name), deliveries(status, driver_id, offered_driver_id)")
    .eq("id", orderId);
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  const { data } = await query.maybeSingle();
  if (!data) return null;
  type Leg = { status: string; driver_id: string | null; offered_driver_id: string | null };
  const r = data as unknown as {
    id: string; status: DbOrderStatus; restaurant_id: string; zone_id: string | null;
    restaurants: { name: string | null } | { name: string | null }[] | null;
    deliveries: Leg | Leg[] | null;
  };
  const shop = Array.isArray(r.restaurants) ? r.restaurants[0] : r.restaurants;
  const d = Array.isArray(r.deliveries) ? r.deliveries[0] : r.deliveries;
  return {
    id: r.id,
    status: r.status,
    restaurantId: r.restaurant_id,
    restaurantName: shop?.name?.trim() || "the restaurant",
    zoneId: r.zone_id,
    delivery: d ? { status: d.status, driverId: d.driver_id, offeredDriverId: d.offered_driver_id } : null,
  };
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
  // Paged: a zone can hold more riders than PostgREST returns in one read.
  const { data: staffRows, error: staffErr } = await readAllRows<{ user_id: string; zone_id: string }>((from, to) => {
    let staff = supabase.from("staff_zones").select("user_id, zone_id");
    if (zones) staff = staff.in("zone_id", zones as string[]);
    return staff.order("user_id").order("zone_id").range(from, to) as unknown as PromiseLike<{ data: { user_id: string; zone_id: string }[] | null; error: unknown }>;
  });
  if (staffErr) throw staffErr;
  const zonesOf = new Map<string, string[]>();
  for (const s of (staffRows ?? []) as { user_id: string; zone_id: string }[]) {
    zonesOf.set(s.user_id, [...(zonesOf.get(s.user_id) ?? []), s.zone_id]);
  }

  // A rider's full zone list decides eligibility, not just the zones the
  // manager shares with them; read it for the riders found above.
  // Chunked: never one URL of every rider id in the zone.
  const people = await readByIds<{ id: string; full_name: string | null; role: string }>("profiles", "id, full_name, role", "id", [...zonesOf.keys()]);
  const riders = people.filter((p) => String(p.role) === "driver");
  if (riders.length === 0) return [];
  const ids = riders.map((r) => r.id);

  type St = { driver_id: string; is_online: boolean; break_until: string | null; last_lat: number | null; last_lng: number | null; last_fix_at: string | null };
  const [allZones, statuses, codes, loads, blocks] = await Promise.all([
    readByIds<{ user_id: string; zone_id: string }>("staff_zones", "user_id, zone_id", "user_id", ids),
    readByIds<St>("rider_status", "driver_id, is_online, break_until, last_lat, last_lng, last_fix_at", "driver_id", ids),
    readByIds<{ driver_id: string; rider_code: string | null }>("rider_profiles", "driver_id, rider_code", "driver_id", ids),
    readByIds<{ driver_id: string }>("deliveries", "driver_id", "driver_id", ids, { status: ["assigned", "picked_up"] }),
    loadWorkBlocks(ids),
  ]);
  const riderZones = new Map<string, string[]>();
  for (const z of allZones) {
    riderZones.set(z.user_id, [...(riderZones.get(z.user_id) ?? []), z.zone_id]);
  }
  const statusOf = new Map(statuses.map((s) => [s.driver_id, s]));
  const codeOf = new Map(codes.map((c) => [c.driver_id, c.rider_code]));
  const loadOf = new Map<string, number>();
  for (const l of loads) loadOf.set(l.driver_id, (loadOf.get(l.driver_id) ?? 0) + 1);

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
      // 0151: a suspended or rejected rider cannot work (rider_can_work).
      suspended: blocks.has(r.id),
      activeDeliveries: loadOf.get(r.id) ?? 0,
    };
    return toRiderCandidate(
      { name: r.full_name, code: codeOf.get(r.id) ?? null },
      facts,
      { orderZoneId: order.zoneId, currentRiderId: current, shop: shopPoint },
      now
    );
  });
  return rankCandidates(list);
}
