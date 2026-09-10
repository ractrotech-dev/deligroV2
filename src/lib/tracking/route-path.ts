import { haversineKm } from "@/lib/geo/distance";
import type { TrackPoint } from "@/lib/tracking/rider-position";

/**
 * Geometry for putting the courier pin on the road.
 *
 * `computeRiderPosition` interpolates the estimated pin along the straight line
 * between shop and door, because a straight line was the only path the app had.
 * Once the map has fetched real road geometry there is a better one, and this
 * module is the translation: how far along the straight line the estimate has
 * travelled, expressed as a point the same fraction of the way along the route.
 *
 * Plain `{lat, lng}` in and out — no `google.maps` types — so it is pure,
 * testable offline, and unaffected by whether the SDK ever loaded.
 *
 * What this does NOT do is move a GPS fix. A reported position is where the
 * courier actually is; snapping it to the route we happen to have drawn would
 * make a real measurement agree with our guess. Only the estimated pin is
 * projected — see the `snapRiderToRoute` prop in `tracking-map.tsx`.
 */

/** Cumulative km at each vertex, so a fraction can be resolved in one pass. */
function cumulativeKm(path: TrackPoint[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    out.push(out[i - 1] + haversineKm(path[i - 1], path[i]));
  }
  return out;
}

/** Total length of a path in km. 0 for a path with fewer than two points. */
export function pathLengthKm(path: TrackPoint[]): number {
  if (path.length < 2) return 0;
  const cum = cumulativeKm(path);
  return cum[cum.length - 1];
}

/**
 * How far along the shop→door line a point has travelled, as 0–1.
 *
 * The estimated pin sits exactly on that line by construction, so a plain
 * distance ratio is exact for it rather than an approximation. Degenerate input
 * — the two ends in the same place — is 0, not a division by zero.
 */
export function progressAlongLine(
  start: TrackPoint,
  end: TrackPoint,
  current: TrackPoint
): number {
  const total = haversineKm(start, end);
  if (total <= 0) return 0;
  const travelled = haversineKm(start, current);
  return Math.min(1, Math.max(0, travelled / total));
}

/**
 * The point `fraction` of the way along `path`, measured by distance rather
 * than by vertex count — a route's points bunch up around junctions, so
 * indexing by count would make the pin crawl through roundabouts and leap down
 * straight sections.
 */
export function pointAlongPath(
  path: TrackPoint[],
  fraction: number
): TrackPoint | null {
  if (path.length === 0) return null;
  if (path.length === 1) return path[0];

  const cum = cumulativeKm(path);
  const total = cum[cum.length - 1];
  if (total <= 0) return path[0];

  const target = Math.min(1, Math.max(0, fraction)) * total;

  for (let i = 1; i < path.length; i++) {
    if (cum[i] < target) continue;
    const segment = cum[i] - cum[i - 1];
    const into = segment <= 0 ? 0 : (target - cum[i - 1]) / segment;
    return {
      lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * into,
      lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * into,
    };
  }

  return path[path.length - 1];
}
