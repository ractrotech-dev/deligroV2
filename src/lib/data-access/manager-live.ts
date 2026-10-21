import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { loadActiveOrderRows, loadOrderRowsByIds, loadRiderInfo } from "@/lib/data-access/manager-ops-orders";
import { buildLiveSnapshot, type LiveRiderRow } from "@/lib/ops/live-snapshot";
import type { LiveSnapshot } from "@/lib/ops/order-contract";

/** A failed delivery stays on the live screen this long (matches live-rules). */
const FAILED_WINDOW_MS = 2 * 60 * 60_000;

/**
 * The live operations snapshot for the manager's zones (§6): active orders,
 * the riders who are on shift or carrying one of those orders, and recent
 * failures. Riders off shift with nothing in hand never appear — location is
 * shown only while it is operationally disclosed (the Rider app's policy).
 * Service role; every read below is limited to the scope's zones.
 */
export async function getLiveSnapshot(scope: ManagerScope, now: Date): Promise<LiveSnapshot> {
  const supabase = createAdminClient();
  const zones = scopeZoneIds(scope);

  const orders = await loadActiveOrderRows(scope);
  const orderIds = orders.map((o) => o.id);

  // Deliveries of the active orders: who carries what, and the fallback position.
  type Leg = { order_id: string; driver_id: string | null; status: string; driver_lat: number | null; driver_lng: number | null; driver_location_at: string | null };
  const legs: Leg[] = [];
  if (orderIds.length) {
    const { data, error } = await supabase
      .from("deliveries")
      .select("order_id, driver_id, status, driver_lat, driver_lng, driver_location_at")
      .in("order_id", orderIds)
      .in("status", ["assigned", "picked_up"]);
    if (error) throw error;
    legs.push(...((data ?? []) as Leg[]));
  }

  // Riders of the scope's zones (admins: every rider with a status row).
  let staff = supabase.from("staff_zones").select("user_id, zone_id");
  if (zones) staff = staff.in("zone_id", zones as string[]);
  const { data: staffRows, error: staffErr } = await staff;
  if (staffErr) throw staffErr;
  const candidateIds = new Set<string>((staffRows ?? []).map((s: { user_id: string }) => s.user_id));
  for (const l of legs) if (l.driver_id) candidateIds.add(l.driver_id);

  // Online riders among them (or, for an admin, anywhere), plus anyone carrying an order in scope.
  type St = { driver_id: string; is_online: boolean; break_until: string | null; last_lat: number | null; last_lng: number | null; last_fix_at: string | null };
  let statusQuery = supabase.from("rider_status").select("driver_id, is_online, break_until, last_lat, last_lng, last_fix_at");
  if (zones) statusQuery = statusQuery.in("driver_id", candidateIds.size ? [...candidateIds] : ["00000000-0000-0000-0000-000000000000"]);
  const { data: statusRows, error: stErr } = await statusQuery;
  if (stErr) throw stErr;
  const statusOf = new Map(((statusRows ?? []) as St[]).map((s) => [s.driver_id, s]));

  const carrying = new Map<string, string[]>();
  for (const l of legs) if (l.driver_id) carrying.set(l.driver_id, [...(carrying.get(l.driver_id) ?? []), l.order_id]);

  const visibleIds = new Set<string>([...carrying.keys()]);
  for (const s of statusOf.values()) if (s.is_online) visibleIds.add(s.driver_id);
  const ids = [...visibleIds];

  const [info, { data: profileRoles }, { data: riderZones }] = await Promise.all([
    loadRiderInfo(ids),
    ids.length ? supabase.from("profiles").select("id, role").in("id", ids) : Promise.resolve({ data: [] }),
    ids.length ? supabase.from("staff_zones").select("user_id, zone_id").in("user_id", ids) : Promise.resolve({ data: [] }),
  ]);
  const drivers = new Set(((profileRoles ?? []) as { id: string; role: string }[]).filter((p) => String(p.role) === "driver").map((p) => p.id));
  const zonesOf = new Map<string, string[]>();
  for (const z of (riderZones ?? []) as { user_id: string; zone_id: string }[]) {
    zonesOf.set(z.user_id, [...(zonesOf.get(z.user_id) ?? []), z.zone_id]);
  }

  const riders: LiveRiderRow[] = ids.filter((id) => drivers.has(id)).map((id) => {
    const st = statusOf.get(id);
    const leg = legs
      .filter((l) => l.driver_id === id && l.driver_location_at && l.driver_lat != null && l.driver_lng != null)
      .sort((a, b) => Date.parse(b.driver_location_at!) - Date.parse(a.driver_location_at!))[0];
    // The newer of the rider's own fix and the delivery row's.
    const own = st?.last_fix_at && st.last_lat != null && st.last_lng != null ? { lat: st.last_lat, lng: st.last_lng, at: st.last_fix_at } : null;
    const viaLeg = leg ? { lat: leg.driver_lat!, lng: leg.driver_lng!, at: leg.driver_location_at! } : null;
    const best = [own, viaLeg].filter((x): x is { lat: number; lng: number; at: string } => !!x)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const r = info.get(id);
    return {
      id,
      name: r?.name ?? "Rider",
      code: r?.code ?? null,
      isOnline: st?.is_online ?? false,
      breakUntil: st?.break_until ?? null,
      lastFixAt: best?.at ?? null,
      lat: best?.lat ?? null,
      lng: best?.lng ?? null,
      zoneIds: zonesOf.get(id) ?? [],
      suspended: false,
      activeOrderIds: carrying.get(id) ?? [],
    };
  });

  // Deliveries that failed recently, for the failure signal (§6.8).
  const since = new Date(now.getTime() - FAILED_WINDOW_MS).toISOString();
  const { data: failedLegs, error: fErr } = await supabase
    .from("deliveries")
    .select("order_id")
    .eq("status", "failed")
    .gte("failed_at", since)
    .limit(200);
  if (fErr) throw fErr;
  const failedRecently = await loadOrderRowsByIds(scope, ((failedLegs ?? []) as { order_id: string }[]).map((f) => f.order_id));

  return buildLiveSnapshot({ orders, riders, failedRecently }, now);
}
