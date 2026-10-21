import { haversineKm } from "@/lib/geo/distance";
import { PINNED_LOCATION } from "@/lib/location/pinned";

/**
 * How far from the operating area a reported fix may be before we treat it as
 * garbage rather than a courier.
 *
 * The cases this catches are all client bugs, not riders: (0, 0) off the coast
 * of Africa, a desktop emulator's San Francisco default, and lat/lng posted the
 * wrong way round (81.5, 21.7 lands in the Arctic Ocean). 1 000 km is
 * deliberately far — it covers every road a Bemetara rider could conceivably be
 * on — so this rejects nonsense without ever refusing a real fix.
 *
 * It is derived from PINNED_LOCATION, i.e. from the single-city assumption. If
 * Deligro opens a city outside this radius, riders there will silently report
 * nothing and their customers will silently get an interpolated dot. Move this
 * with the city list, not after it.
 */
export const MAX_FIX_KM = 1000;

/**
 * Whether a position from a rider's device is plausible: finite, a real
 * latitude and longitude, and within MAX_FIX_KM of the operating area.
 *
 * The single definition of that rule. `reportDriverLocation` (the in-flight
 * delivery's position) and `recordRiderFix` (the rider's availability fix) both
 * call it, so the two can never disagree about what a valid fix is.
 */
export function isPlausibleFix(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return haversineKm(PINNED_LOCATION.coords, { lat, lng }) <= MAX_FIX_KM;
}
