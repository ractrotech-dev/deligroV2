/*
 * A local `distanceKm` haversine helper lived here. Its only caller was
 * `restaurantPointForOrder`, deleted below, so it went with it rather than
 * staying as an unused second copy of `lib/geo/distance`.
 */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * How far along the route an ESTIMATED pin is ever allowed to travel.
 *
 * The estimate used to run the full 0→1 ramp, so a courier who had broken down,
 * gone to the wrong door or stopped for another order was still drawn arriving
 * at the customer's address, exactly on schedule, off nothing but a clock. The
 * caption calls the pin an estimate; it does not stop the estimate asserting an
 * arrival that never happened.
 *
 * Short of 1, arrival can only come from a real signal — a GPS fix, or the
 * delivery being marked complete. The pin says "somewhere along the way", which
 * is the most an interpolation actually knows.
 */
const MAX_ESTIMATED_PROGRESS = 0.85;

export interface TrackPoint {
  lat: number;
  lng: number;
}

export interface RiderPositionInput {
  orderStatus: string;
  deliveryStatus: string | null;
  assignedAt: string | null;
  pickedUpAt: string | null;
  /**
   * Where the food started. Null when the shop has never been pinned — and it
   * genuinely is null rather than a stand-in, because the stand-in was the bug:
   * a marker hashed from the restaurant's UUID, drawn to the customer as the
   * place their dinner left from.
   */
  restaurant: TrackPoint | null;
  destination: TrackPoint;
  storedRider: (TrackPoint & { at: string | null }) | null;
  etaMinutes: number;
  now?: number;
}

/**
 * Returns where the rider pin should sit right now.
 *
 * Uses stored GPS when fresh. Past that window it falls back to a point along
 * the straight line between shop and door, derived from elapsed time — an
 * estimate, labelled as one by `riderPositionSourceFor` and captioned as one on
 * the tracking screen.
 *
 * Two things it deliberately does NOT do, both removed because they made the
 * estimate assert more than it knows:
 *
 *  - It does not jitter. Before pickup the pin used to wobble ±0.00008° on a
 *    sine wave, for no reason but to "feel alive" — motion invented to suggest a
 *    courier was moving when we had no idea whether they were.
 *  - It does not arrive. The ramp stops at `MAX_ESTIMATED_PROGRESS`, so the
 *    clock alone can never walk the pin onto the customer's doorstep.
 */
export function computeRiderPosition(input: RiderPositionInput): TrackPoint | null {
  const now = input.now ?? Date.now();

  if (
    input.storedRider?.lat != null &&
    input.storedRider?.lng != null &&
    input.storedRider.at
  ) {
    const age = now - new Date(input.storedRider.at).getTime();
    if (age < 45_000) {
      return { lat: input.storedRider.lat, lng: input.storedRider.lng };
    }
  }

  const activeDelivery =
    input.deliveryStatus === "assigned" || input.deliveryStatus === "picked_up";
  const onTheWay =
    input.orderStatus === "on_the_way" || input.deliveryStatus === "picked_up";

  if (!activeDelivery && input.orderStatus !== "on_the_way") {
    return null;
  }

  // No pinned shop, and the GPS check above did not return: there is no origin
  // to interpolate from. Every branch below either parks the pin ON the shop or
  // walks it along the line out of the shop, so both need a real start.
  //
  // This is the third thing this function refuses to invent, alongside the
  // jitter and the arrival described above — and the same reasoning applies. A
  // pin drawn from a fabricated origin is not a weaker estimate, it is a
  // confident statement about a place nobody ever set.
  const start = input.restaurant;
  if (!start) return null;

  const end = input.destination;
  const etaMs = Math.max(input.etaMinutes, 8) * 60_000;

  if (!onTheWay) {
    // Heading to the restaurant for pickup. The food is still at the shop and
    // that is the only location this branch can defend, so the pin sits on it
    // and stays put.
    return start;
  }

  const since = input.pickedUpAt ?? input.assignedAt;
  if (!since) {
    return start;
  }

  const elapsed = now - new Date(since).getTime();
  const progress = clamp01(elapsed / etaMs) * MAX_ESTIMATED_PROGRESS;

  return {
    lat: lerp(start.lat, end.lat, progress),
    lng: lerp(start.lng, end.lng, progress),
  };
}

/*
 * `restaurantPointForOrder` used to live here: given an unpinned shop it
 * returned Bemetara's centre plus a fixed offset, and if that landed within
 * 50 m of the customer it moved 0.8 km away at an angle hashed from the
 * restaurant's UUID. Deleted rather than left unused — it was the origin of a
 * route line drawn to customers as the place their food came from, on a
 * database where 68 of 70 shops have no pin.
 *
 * There is no replacement, deliberately. An unpinned shop now yields `null` all
 * the way through `order-tracking.ts` to the map, which draws the destination
 * alone. Pinning the shop is what brings the route back.
 */
