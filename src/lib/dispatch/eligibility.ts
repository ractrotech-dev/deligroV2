import { isDispatchable, type RiderAvailability } from "@/lib/rider/availability";

/**
 * Which riders dispatch may offer a pickup to — the rule, with no database.
 *
 * Pure on purpose (no `server-only`): `scripts/qa/rider-dispatch-eligibility.ts`
 * runs it under tsx, and `loadCandidates` in `rider-dispatch.ts` is the thin
 * wrapper that reads `rider_status` and asks this.
 *
 * A rider is eligible when `isDispatchable` says so — online, not on a break,
 * and a position newer than RIDER_PRESENCE_MS. A rider with no entry in
 * `availability` has no `rider_status` row, which means they have never gone
 * online: they are NOT eligible. (The one deliberate exception — a database
 * without migration 0081, where there is no table to ask — is handled by the
 * caller before it gets here, so that dispatch never goes dark before the
 * migration is applied.)
 *
 * The input order is kept: the caller's own sort decides who is best.
 */
export function eligibleCandidates<T extends { id: string }>(
  riders: T[],
  availability: Map<string, RiderAvailability>,
  now: Date
): T[] {
  return riders.filter((rider) => {
    const state = availability.get(rider.id);
    return state !== undefined && isDispatchable(state, now);
  });
}

/**
 * Riders kept off dispatch by an expired document (0086
 * `block_dispatch_on_expired_docs`). `blocked` is empty unless the admin
 * setting is on (`loadDocumentBlockedRiders` reads it; the rule itself is
 * `dispatchBlockedByDocuments` in lib/rider/profile-rules.ts). Input order is
 * kept.
 */
export function withoutDocumentBlocked<T extends { id: string }>(riders: T[], blocked: ReadonlySet<string>): T[] {
  return blocked.size === 0 ? riders : riders.filter((rider) => !blocked.has(rider.id));
}
