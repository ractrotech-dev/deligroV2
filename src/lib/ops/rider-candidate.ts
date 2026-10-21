/**
 * One row of the rider picker (`GET /api/manager/orders/[id]/riders`), built
 * from plain facts. Pure, so the route and the contract emitter
 * (`scripts/qa/manager-contract-emit.ts`) serialise a candidate the same way.
 */
import { riderPhase } from "@/lib/rider/availability";
import { riderEligibility, type RiderFacts } from "./live-rules";
import type { RiderCandidate } from "./order-contract";

export function toRiderCandidate(
  person: { name: string | null; code: string | null },
  facts: RiderFacts,
  ctx: { orderZoneId: string; currentRiderId: string | null; shop: { lat: number; lng: number } | null },
  now: Date
): RiderCandidate {
  const e = riderEligibility(facts, ctx, now);
  const fixMs = facts.lastFixAt ? Date.parse(facts.lastFixAt) : Number.NaN;
  return {
    id: facts.id,
    name: person.name?.trim() || "Rider",
    code: person.code,
    phase: riderPhase({ isOnline: facts.isOnline, breakUntil: facts.breakUntil, onlineSince: null, lastFixAt: facts.lastFixAt }, now),
    activeDeliveries: facts.activeDeliveries,
    distanceKm: e.distanceKm,
    lastFixAgeSeconds: Number.isFinite(fixMs) ? Math.max(0, Math.floor((now.getTime() - fixMs) / 1000)) : null,
    eligible: e.eligible,
    ineligibleReason: e.ineligibleReason,
  };
}
