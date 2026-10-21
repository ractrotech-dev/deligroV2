/**
 * Road distance between two points from an OSRM-compatible routing server
 * (`platform_settings.routing_base_url`, 0082).
 *
 * Not `server-only` and free of the database: it takes the `fetch` to use, so
 * `scripts/qa/rider-jobs.ts` drives it with a fake. Never throws: a slow or
 * broken routing server must not be able to hurt anything it is asked for, so
 * every failure is `null` and the caller keeps its straight-line estimate.
 */

type Point = { lat: number; lng: number };

/** Short on purpose: this runs after the rider has already been given the job. */
export const ROUTING_TIMEOUT_MS = 2000;

/**
 * `${base}/route/v1/driving/{fromLng},{fromLat};{toLng},{toLat}?overview=false`,
 * `routes[0].distance` metres -> km to two decimals. Null on a non-https base
 * (the setting is constrained to https; this does not trust that), a timeout,
 * a network error, a non-2xx answer, `code` other than "Ok", or no usable route.
 */
export async function roadDistanceKm(
  baseUrl: string,
  from: Point,
  to: Point,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<number | null> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\/.+/i.test(base)) return null;
  const coords = [from.lng, from.lat, to.lng, to.lat];
  if (!coords.every((n) => typeof n === "number" && Number.isFinite(n))) return null;

  const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? ROUTING_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      code?: unknown;
      routes?: { distance?: unknown }[];
    };
    if (body.code !== "Ok") return null;
    const metres = body.routes?.[0]?.distance;
    if (typeof metres !== "number" || !Number.isFinite(metres) || metres < 0) return null;
    return Math.round((metres / 1000) * 100) / 100;
  } catch {
    return null;
  }
}
