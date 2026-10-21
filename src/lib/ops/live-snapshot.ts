/**
 * The live operations snapshot (§6), built from rows the data layer has
 * already scoped to the manager's zones. Pure, so the shape the map draws is
 * tested without a database.
 */
import {
  INACTIVE_MINUTES,
  PICKUP_WAIT_MINUTES,
  PREP_GRACE_MINUTES,
  STALE_FIX_SECONDS,
  UNASSIGNED_MINUTES,
  delayFor,
  fixAgeSeconds,
  liveSignals,
  riderMarkerState,
} from "./live-rules";
import type { LiveOrder, LiveRider, LiveSnapshot } from "./order-contract";
import { liveFacts, toOrderListItem, type OpsOrderRow } from "./order-row";

export interface LiveRiderRow {
  id: string;
  name: string;
  code: string | null;
  isOnline: boolean;
  breakUntil: string | null;
  lastFixAt: string | null;
  lat: number | null;
  lng: number | null;
  zoneIds: string[];
  suspended: boolean;
  /** Active (assigned / picked-up) deliveries in scope. */
  activeOrderIds: string[];
  /** Profile phone; only ever passed through by `riderPhone()`. */
  phone?: string | null;
}

export interface LiveRows {
  /** Non-terminal orders in scope. */
  orders: OpsOrderRow[];
  /** Riders online, or holding an active delivery in scope. */
  riders: LiveRiderRow[];
  /** Orders whose delivery failed in the last two hours (for the failure signal). */
  failedRecently: OpsOrderRow[];
  /**
   * The caller's zones, for the rider-call rule: `null` = every zone (admin).
   * Left out, no rider phone is ever shown.
   */
  scopeZoneIds?: string[] | null;
}

/**
 * Dispatch may call a rider who is working for it (rider design §15.5): a
 * rider in one of the caller's zones who is online or carrying an order. The
 * map only holds such riders, so the zone is the remaining test. Anyone else —
 * another zone's rider passing through, a rider with no zone — gets no number.
 */
function riderPhone(r: LiveRiderRow, scopeZoneIds: string[] | null | undefined): string | null {
  if (scopeZoneIds === undefined) return null;
  if (!r.phone) return null;
  if (!(r.isOnline || r.activeOrderIds.length > 0)) return null;
  if (scopeZoneIds === null) return r.phone;
  return r.zoneIds.some((z) => scopeZoneIds.includes(z)) ? r.phone : null;
}

const point = (lat: number | null | undefined, lng: number | null | undefined) =>
  lat == null || lng == null ? null : { lat, lng };

export function buildLiveSnapshot(rows: LiveRows, now: Date): LiveSnapshot {
  // Location only for riders on shift or carrying food in scope (§6 privacy).
  const visible = rows.riders.filter((r) => r.isOnline || r.activeOrderIds.length > 0);

  const riders: LiveRider[] = visible.map((r) => {
    const age = fixAgeSeconds(r, now);
    const facts = { ...r, activeDeliveries: r.activeOrderIds.length };
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      riderCode: r.code,
      state: riderMarkerState(facts, now),
      lat: r.lat,
      lng: r.lng,
      lastFixAt: r.lastFixAt,
      lastFixAgeSeconds: age,
      stale: age === null || age > STALE_FIX_SECONDS,
      activeOrderIds: r.activeOrderIds,
      phone: riderPhone(r, rows.scopeZoneIds),
    };
  });

  const orders: LiveOrder[] = rows.orders.map((o) => ({
    ...toOrderListItem(o, now),
    pickupPoint: point(o.vendor.lat, o.vendor.lng),
    dropPoint: point(o.drop?.lat, o.drop?.lng),
  }));

  const lanes = { placed: 0, kitchen: 0, ready: 0, on_the_way: 0 };
  for (const o of rows.orders) {
    if (o.status in lanes) lanes[o.status as keyof typeof lanes] += 1;
  }

  const delayed: LiveSnapshot["delayed"] = [];
  const unassigned: string[] = [];
  for (const o of rows.orders) {
    const d = delayFor(liveFacts(o), now);
    if (!d) continue;
    delayed.push({ orderId: o.id, kind: d.kind, minutes: d.minutes });
    if (d.kind === "unassigned") unassigned.push(o.id);
  }

  const signals = liveSignals(
    [...rows.orders, ...rows.failedRecently].map((o) => ({ ...liveFacts(o), id: o.id })),
    visible.map((r) => ({ ...r, activeDeliveries: r.activeOrderIds.length })),
    now
  );

  return {
    generatedAt: now.toISOString(),
    riders,
    orders,
    lanes,
    unassigned,
    delayed,
    signals,
    thresholds: {
      staleSeconds: STALE_FIX_SECONDS,
      inactiveMinutes: INACTIVE_MINUTES,
      unassignedMinutes: UNASSIGNED_MINUTES,
      prepGraceMinutes: PREP_GRACE_MINUTES,
      pickupWaitMinutes: PICKUP_WAIT_MINUTES,
    },
  };
}
