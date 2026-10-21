import { riderPhase, type RiderAvailability } from "@/lib/rider/availability";

/**
 * Which riders may take an order — the rule, with no database. The ONE rule:
 * dispatch (`eligibleCandidates`, called by `loadCandidates` in
 * rider-dispatch.ts), the manager's rider picker and live map
 * (`riderEligibility` in src/lib/ops/live-rules.ts) and the database
 * (`_ops_rider_ineligible`, migration 0142) all decide the same way, in the
 * same order.
 *
 * Pure on purpose (no `server-only`): scripts/qa/rider-dispatch-eligibility.ts
 * and scripts/qa/rider-eligibility-unified.ts run it under tsx.
 *
 * A rider is eligible when they are online, not on a break, have a position
 * within RIDER_PRESENCE_MS of now (either side: a phone clock running ahead must
 * not keep a rider "fresh"), are not suspended, work in the order's zone, and
 * are not already the rider on it. A rider with no `rider_status` row has never
 * gone online: they are NOT eligible. (The one deliberate exception — a
 * database without migration 0081, where there is no table to ask — is handled
 * by the caller before it gets here, so that dispatch never goes dark before
 * the migration is applied.)
 */
export type IneligibleReason = "offline" | "on_break" | "stale_fix" | "suspended" | "out_of_zone" | "current_rider";

export interface EligibilityFacts extends RiderAvailability {
  /** 0151 rider_can_work is false: a suspended account or a rejected verification (src/lib/data-access/rider-work.ts). */
  suspended: boolean;
  /** The rider's staff_zones. */
  zoneIds: string[];
}

export interface EligibilityContext {
  /**
   * The order's zone. `null` = an order with no zone, which is nobody's zone.
   * `undefined` = zones are not known here (a database without 0141), so the
   * zone is not checked rather than refusing everyone.
   */
  orderZoneId: string | null | undefined;
  /** The rider already on the order, for a reassignment. */
  currentRiderId: string | null;
}

/** The first reason this rider may not take the order, or null. */
export function riderIneligibility(
  riderId: string,
  r: EligibilityFacts,
  ctx: EligibilityContext,
  now: Date
): IneligibleReason | null {
  const phase = riderPhase(r, now);
  if (phase === "offline") return "offline";
  if (phase === "break") return "on_break";
  if (phase === "stale") return "stale_fix";
  if (r.suspended) return "suspended";
  if (ctx.orderZoneId !== undefined && (ctx.orderZoneId === null || !r.zoneIds.includes(ctx.orderZoneId))) {
    return "out_of_zone";
  }
  if (ctx.currentRiderId !== null && ctx.currentRiderId === riderId) return "current_rider";
  return null;
}

/**
 * The reasons a manager may put a rider on anyway, with a reason that is
 * recorded (0142 `p_override`): things they can see past from where they
 * stand — the rider is on the phone with them. Never another zone, a
 * suspension, or the same rider.
 */
export function canOverride(reason: IneligibleReason): boolean {
  return reason === "offline" || reason === "on_break" || reason === "stale_fix";
}

/**
 * Dispatch's filter: the riders who may be offered this order. A rider with no
 * entry in `availability` has no `rider_status` row and is not eligible. Zones
 * are checked when `zone` is given (the order's zone and each rider's zones are
 * in `availability`); input order is kept — the caller's own sort decides who
 * is best.
 */
export function eligibleCandidates<T extends { id: string }>(
  riders: T[],
  availability: Map<string, RiderAvailability | EligibilityFacts>,
  now: Date,
  zone?: { orderZoneId: string | null }
): T[] {
  return riders.filter((rider) => {
    const state = availability.get(rider.id);
    if (state === undefined) return false;
    const facts: EligibilityFacts = {
      suspended: false,
      zoneIds: [],
      ...state,
    };
    return riderIneligibility(rider.id, facts, { orderZoneId: zone ? zone.orderZoneId : undefined, currentRiderId: null }, now) === null;
  });
}
