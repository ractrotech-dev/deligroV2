import { earningsJson, earningsRouteError, riderEarningsGate } from "@/lib/auth/rider-earnings-route";
import { getIncentiveProgress } from "@/lib/data-access/rider-earnings";

const ROUTE = "/api/rider/earnings/incentives";

/**
 * GET /api/rider/earnings/incentives — each active incentive rule in force
 * today, shown verbatim, with the rider's progress in the current period
 * (today, or the IST week from Monday): the same count the database awards on.
 *
 *   200 { incentives: { ruleId, name, period, target, done, bonus, window,
 *         endsOn, earned }[] }
 *   401 · 403 not_rider | feature_disabled (`driver.earnings` or
 *   `driver.incentives` off) · 429 · 503 migration_pending · 500
 */
export async function GET() {
  const gate = await riderEarningsGate(ROUTE, { feature: "driver.incentives" });
  if (!gate.ok) return gate.response;
  try {
    return earningsJson({ incentives: await getIncentiveProgress(gate.driverId) });
  } catch (e) {
    return earningsRouteError(e, ROUTE, gate.driverId);
  }
}
