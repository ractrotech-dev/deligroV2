/**
 * `Server-Timing` header value, for splitting a slow request into the part the
 * server spent and the part the network did.
 *
 * Durations only. Never put an id, a path, a token or anything about the user
 * in a metric: the header is readable by whoever made the request, and by
 * `PerformanceResourceTiming.serverTiming` in their browser.
 *
 * One header carrying every metric, comma-separated. Setting `Server-Timing`
 * once per metric overwrites rather than appends on a `Headers` object, so the
 * last metric set would silently be the only one a browser ever saw.
 */
export type TimingMetric = readonly [name: string, ms: number];

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function serverTimingHeader(metrics: readonly TimingMetric[]): string {
  return metrics
    .filter(
      ([name, ms]) => TOKEN.test(name) && Number.isFinite(ms) && ms >= 0
    )
    .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
    .join(", ");
}
