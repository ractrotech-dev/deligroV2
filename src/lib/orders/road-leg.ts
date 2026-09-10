import { haversineKm } from "@/lib/geo/distance";
import type { TrackPoint } from "@/lib/tracking/rider-position";

/**
 * How long the road leg actually takes, from how far apart the two ends are.
 *
 * What it replaces: nothing. That is the point. `computeOrderEta` derived the
 * road leg as `advertisedBand - prepMinutes`, so distance was not an input to
 * the customer's estimate anywhere in the app — a shop's 30-minute band was the
 * whole promise whether the address was 2 km away or 75. A test order from
 * Bemetara to Durg (75 km by road, 1h51m by car) was tracked as a ~25 minute
 * delivery, counting down to an arrival that was two hours out.
 *
 * Pure and synchronous, like `eta.ts` which consumes it: no I/O, no clock, no
 * Directions call. That is deliberate and it is the whole design constraint.
 * The tracking screen polls every 3 seconds, so a routing request on the server
 * path would be roughly 1,200 billed lookups per hour-long delivery. The map
 * does call Directions for the real road geometry — once per order, in the
 * browser, see `tracking-map.tsx` — and the screen shows the longer of that
 * answer and this one. This module is what makes the server's estimate
 * distance-aware for free.
 *
 * So this is a MODEL, not a measurement, and every constant below is stated
 * rather than tuned into invisibility.
 */

/**
 * Roads are longer than the crow flies. 1.25 is the usual planning figure; the
 * Bemetara→Durg leg this was calibrated against measured 1.18 (63.8 km direct,
 * 75.3 km driven), so 1.25 leaves the estimate slightly long.
 *
 * That direction is chosen. An estimate that runs late costs a customer a
 * refresh; one that runs early costs them a wait they were told was over, and
 * `computeOrderEta` reports lateness off this number.
 */
const DETOUR_FACTOR = 1.25;

/**
 * Town riding and highway riding are not the same speed, and a single average
 * cannot describe both: pick the town figure and a 75 km trip reads as five
 * hours, pick the highway figure and a 2 km trip reads as three minutes.
 *
 * The first few km of any trip are the slow ones — lights, lanes, the actual
 * town the shop sits in — so they are charged at the town rate whatever the
 * total, and only the remainder gets the open-road rate.
 */
const TOWN_KM = 5;
const TOWN_SPEED_KMH = 18;
const HIGHWAY_SPEED_KMH = 45;

/**
 * Neither end of a delivery is a point the rider drives to at speed: there is
 * parking, a gate, a staircase, a phone call from the door. Flat, because it
 * does not scale with distance — it is the same five minutes on a 2 km run as
 * on a 75 km one.
 */
const HANDLING_MINUTES = 5;

/** Road km implied by a straight-line distance. */
export function roadKmFor(straightLineKm: number): number {
  return straightLineKm * DETOUR_FACTOR;
}

/**
 * Minutes for a road leg of `straightLineKm` as the crow flies, or `null` when
 * the distance is unknown.
 *
 * Null is not zero and callers must not treat it as one: an order whose address
 * was never pinned has no measurable distance, and the honest fallback is the
 * restaurant's advertised band, not a modelled leg built on a coordinate we
 * guessed. See `roadLegBetween`.
 */
export function roadMinutesFor(
  straightLineKm: number | null | undefined
): number | null {
  if (
    typeof straightLineKm !== "number" ||
    !Number.isFinite(straightLineKm) ||
    straightLineKm < 0
  ) {
    return null;
  }

  const roadKm = roadKmFor(straightLineKm);
  const townKm = Math.min(roadKm, TOWN_KM);
  const highwayKm = Math.max(roadKm - TOWN_KM, 0);

  const minutes =
    (townKm / TOWN_SPEED_KMH) * 60 +
    (highwayKm / HIGHWAY_SPEED_KMH) * 60 +
    HANDLING_MINUTES;

  return Math.round(minutes);
}

/**
 * The modelled road leg between two points, when both are genuinely known.
 *
 * Both arguments are nullable on purpose. A shop that has never been pinned
 * falls back to a synthetic marker (see `restaurantPointForOrder`) and an
 * address with no coordinates falls back to the centre of Bemetara — and the
 * distance between two fabrications is a fabrication with a number on it. When
 * either end is missing this returns null and the estimate stays on the band,
 * which is the same thing the app already did before distance existed.
 */
export function roadLegBetween(
  shop: TrackPoint | null | undefined,
  destination: TrackPoint | null | undefined
): { straightLineKm: number; roadKm: number; minutes: number } | null {
  if (!shop || !destination) return null;

  const straightLineKm = haversineKm(shop, destination);
  const minutes = roadMinutesFor(straightLineKm);
  if (minutes === null) return null;

  return { straightLineKm, roadKm: roadKmFor(straightLineKm), minutes };
}
