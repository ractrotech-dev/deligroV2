/**
 * Live operations rules — the one place that decides when an order is late
 * and why, what a rider's map marker shows, whether a rider may take an order,
 * and which conditions deserve a manager's attention.
 *
 * Pure (no I/O) so the order list, the order detail, the live map and Phase 8's
 * alert engine all read the same answer. The thresholds are constants for now;
 * Phase 8 turns them into per-zone settings without changing these signatures.
 * The database repeats the eligibility rule in `_ops_rider_ineligible()` (0142),
 * in the same order, so the picker and the RPC never disagree.
 */
import { computeOrderEta, kitchenPrepMinutes } from "@/lib/orders/eta";
import { RIDER_PRESENCE_MS } from "@/lib/rider/availability";
import { dbStatusToUi } from "@/lib/utils/order-map";
import type {
  DbOrderStatus,
  DelayKind,
  EtaView,
  IneligibleReason,
  LiveSignal,
  RiderMarkerState,
} from "./order-contract";

export type { DelayKind, SignalKind } from "./order-contract";

/** A rider's marker turns grey when the last fix is older than this (§6.12). */
export const STALE_FIX_SECONDS = 120;
/** A rider on an active delivery with no fix for this long is "inactive" (§6.7). */
export const INACTIVE_MINUTES = 5;
/** An accepted or ready order with no rider for this long is "unassigned". */
export const UNASSIGNED_MINUTES = 5;
/** Minutes past the promised prep time before the kitchen counts as late. */
export const PREP_GRACE_MINUTES = 5;
/** Minutes a ready order may wait for its assigned rider before pickup is late. */
export const PICKUP_WAIT_MINUTES = 10;
/** A failed delivery stays a signal for this long. */
const FAILED_SIGNAL_MINUTES = 120;

const MINUTE = 60_000;

export interface LiveOrderFacts {
  status: DbOrderStatus;
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  /** `orders.prep_minutes` (0061), the kitchen's promise; null = the default. */
  prepMinutes: number | null;
  etaMin: number | null;
  etaMax: number | null;
  /** Straight-line shop → drop, km. */
  distanceKm: number | null;
  delivery: {
    status: string;
    driverId: string | null;
    pickedUpAt: string | null;
    failedAt: string | null;
  } | null;
}

export interface RiderFacts {
  id: string;
  isOnline: boolean;
  breakUntil: string | null;
  lastFixAt: string | null;
  lat: number | null;
  lng: number | null;
  zoneIds: string[];
  suspended: boolean;
  activeDeliveries: number;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isTerminal(status: DbOrderStatus): boolean {
  return status === "delivered" || status === "cancelled";
}

function hasRider(o: LiveOrderFacts): boolean {
  return !!o.delivery && !!o.delivery.driverId && o.delivery.status !== "unassigned"
    && o.delivery.status !== "cancelled" && o.delivery.status !== "failed";
}

/** Minutes the order is promised to spend in the kitchen. */
function promisedPrep(o: LiveOrderFacts): number {
  return kitchenPrepMinutes({ restaurantPrepMinutes: o.prepMinutes });
}

/** Great-circle km; local so this module stays free of client-store types. */
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Rounded to 0.1 km, the precision a manager reads a distance at. */
export function distanceKm(
  a: { lat: number | null; lng: number | null } | null,
  b: { lat: number | null; lng: number | null } | null
): number | null {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  return Math.round(km({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) * 10) / 10;
}

/**
 * The ETA a manager sees: when the food should be ready for pickup, when it
 * should arrive, the outer promise, and how late it is. Null once terminal.
 */
export function orderEtaView(o: LiveOrderFacts, now: Date): EtaView | null {
  if (isTerminal(o.status)) return null;
  const eta = computeOrderEta({
    status: dbStatusToUi(o.status),
    createdAt: o.createdAt,
    acceptedAt: o.acceptedAt,
    readyAt: o.readyAt,
    pickedUpAt: o.delivery?.pickedUpAt ?? null,
    etaMin: o.etaMin,
    etaMax: o.etaMax,
    restaurantPrepMinutes: o.prepMinutes,
    straightLineKm: o.distanceKm,
    now: now.getTime(),
  });

  let pickupAt: string | null = null;
  if (o.readyAt && o.status !== "kitchen" && o.status !== "placed") {
    pickupAt = o.readyAt;
  } else {
    const accepted = ms(o.acceptedAt);
    if (accepted !== null) pickupAt = new Date(accepted + promisedPrep(o) * MINUTE).toISOString();
  }

  return {
    pickupAt,
    expectedAt: eta.expectedAt,
    dueAt: eta.dueAt,
    late: eta.late,
    lateByMinutes: eta.lateByMinutes,
  };
}

/** Whole minutes from `since` to `now`, or null without an anchor. */
function minutesSince(since: string | null, now: Date): number | null {
  const t = ms(since);
  return t === null ? null : Math.floor((now.getTime() - t) / MINUTE);
}

/**
 * The single delay an order carries, if any. Priority: no rider, then the
 * delivery promise, then a rider who has not collected, then the kitchen.
 */
export function delayFor(o: LiveOrderFacts, now: Date): { kind: DelayKind; minutes: number } | null {
  if (isTerminal(o.status) || o.status === "placed") return null;

  if (!hasRider(o)) {
    const anchor = o.status === "kitchen" ? o.acceptedAt : (o.readyAt ?? o.acceptedAt);
    const waited = minutesSince(anchor, now);
    if (waited !== null && waited - UNASSIGNED_MINUTES > 0) {
      return { kind: "unassigned", minutes: waited - UNASSIGNED_MINUTES };
    }
  }

  const eta = orderEtaView(o, now);
  if (eta?.late) return { kind: "delivery", minutes: eta.lateByMinutes };

  if (o.status === "ready" && hasRider(o) && !o.delivery?.pickedUpAt) {
    const waited = minutesSince(o.readyAt, now);
    if (waited !== null && waited - PICKUP_WAIT_MINUTES > 0) {
      return { kind: "pickup", minutes: waited - PICKUP_WAIT_MINUTES };
    }
  }

  if (o.status === "kitchen") {
    const cooking = minutesSince(o.acceptedAt, now);
    const over = cooking === null ? null : cooking - promisedPrep(o) - PREP_GRACE_MINUTES;
    if (over !== null && over > 0) return { kind: "prep", minutes: over };
  }

  return null;
}

function onBreak(r: RiderFacts, now: Date): boolean {
  const until = ms(r.breakUntil);
  return until !== null && until > now.getTime();
}

function fixAgeSeconds(r: { lastFixAt: string | null }, now: Date): number | null {
  const t = ms(r.lastFixAt);
  return t === null ? null : Math.max(0, Math.floor((now.getTime() - t) / 1000));
}

/** What the rider's marker on the live map shows. A break outranks a stale fix. */
export function riderMarkerState(r: RiderFacts, now: Date): RiderMarkerState {
  if (onBreak(r, now)) return "break";
  const age = fixAgeSeconds(r, now);
  if (age === null || age > STALE_FIX_SECONDS) return "stale";
  return r.activeDeliveries > 0 ? "on_delivery" : "available";
}

/**
 * May this rider take this order? The first failing reason, in the order the
 * picker explains them: offline, on a break, no fresh fix, suspended, not in
 * the order's zone (a rider with no zones is never in one), already on it.
 */
export function riderEligibility(
  r: RiderFacts,
  ctx: { orderZoneId: string; currentRiderId: string | null; shop: { lat: number; lng: number } | null },
  now: Date
): { eligible: boolean; ineligibleReason: IneligibleReason | null; distanceKm: number | null } {
  const dist = ctx.shop ? distanceKm({ lat: r.lat, lng: r.lng }, ctx.shop) : null;
  const age = fixAgeSeconds(r, now);
  let reason: IneligibleReason | null = null;
  if (!r.isOnline) reason = "offline";
  else if (onBreak(r, now)) reason = "on_break";
  else if (age === null || age * 1000 >= RIDER_PRESENCE_MS) reason = "stale_fix";
  else if (r.suspended) reason = "suspended";
  else if (!r.zoneIds.includes(ctx.orderZoneId)) reason = "out_of_zone";
  else if (ctx.currentRiderId !== null && ctx.currentRiderId === r.id) reason = "current_rider";
  return { eligible: reason === null, ineligibleReason: reason, distanceKm: dist };
}

/** Eligible first; then nearer to the shop (unknown distance last); then lighter load. */
export function rankCandidates<T extends { eligible: boolean; distanceKm: number | null; activeDeliveries: number }>(
  list: T[]
): T[] {
  return [...list].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return a.activeDeliveries - b.activeDeliveries;
  });
}

/**
 * Conditions a manager should hear about. Computed, never stored: Phase 8's
 * alert engine calls this and decides what opens an alert.
 */
export function liveSignals(
  orders: (LiveOrderFacts & { id: string })[],
  riders: (RiderFacts & { activeOrderIds: string[] })[],
  now: Date
): LiveSignal[] {
  const out: LiveSignal[] = [];
  const nowIso = now.toISOString();

  for (const r of riders) {
    if (r.activeOrderIds.length === 0) continue;
    const age = fixAgeSeconds(r, now);
    const minutes = age === null ? null : Math.floor(age / 60);
    if (minutes === null || minutes > INACTIVE_MINUTES) {
      out.push({
        kind: "rider_inactive",
        orderId: r.activeOrderIds[0] ?? null,
        riderId: r.id,
        minutes: minutes ?? 0,
        at: r.lastFixAt ?? nowIso,
      });
    }
  }

  for (const o of orders) {
    if (o.delivery?.status === "failed") {
      const since = minutesSince(o.delivery.failedAt, now);
      if (since !== null && since <= FAILED_SIGNAL_MINUTES) {
        out.push({ kind: "delivery_failed", orderId: o.id, riderId: o.delivery.driverId, minutes: since,
          at: o.delivery.failedAt ?? nowIso });
      }
      continue;
    }
    const delay = delayFor(o, now);
    if (!delay) continue;
    const kind =
      delay.kind === "unassigned" ? "order_unassigned"
      : delay.kind === "prep" ? "prep_delayed"
      : "delivery_delayed";
    out.push({ kind, orderId: o.id, riderId: o.delivery?.driverId ?? null, minutes: delay.minutes, at: nowIso });
  }

  return out;
}

export { fixAgeSeconds };
