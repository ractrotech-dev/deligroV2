import { insightsJson, insightsRouteError, riderInsightsGate } from "@/lib/auth/rider-insights-route";
import { getRiderRatings } from "@/lib/data-access/rider-insights";

const ROUTE = "/api/rider/ratings";

/**
 * GET /api/rider/ratings?cursor=…
 *
 * How customers rated the rider: the average, the count, and their ratings and
 * comments newest first, 20 a page. Rating, comment and time only - never who
 * left it, and no order code (a comment is shown without attribution).
 *
 *   200 { average: number | null, count, items: { rating, comment, at }[], nextCursor: string | null }
 *   400 invalid_cursor
 *   401 · 403 not_rider | feature_disabled (`driver.performance` off) · 429 · 503 migration_pending (no 0084) · 500
 */
export async function GET(request: Request) {
  const gate = await riderInsightsGate(ROUTE, { feature: "driver.performance" });
  if (!gate.ok) return gate.response;
  try {
    return insightsJson(await getRiderRatings(gate.driverId, { cursor: new URL(request.url).searchParams.get("cursor") }));
  } catch (e) {
    return insightsRouteError(e, ROUTE, gate.driverId);
  }
}
