import { earningsJson, earningsRouteError, riderEarningsGate } from "@/lib/auth/rider-earnings-route";
import { getEarningsSummary } from "@/lib/data-access/rider-earnings";

const ROUTE = "/api/rider/earnings/summary";

/**
 * GET /api/rider/earnings/summary — the Earnings tab's figures.
 *
 *   200 EarningsSummary { today, week, month, total, perDeliveryAvg,
 *       deliveriesCounted, incentives, bonuses, adjustments, deductions,
 *       salary, paid, pending, lastPayout }
 *
 * IST calendar (today, the week from Monday, the month). `pending` may be
 * negative: a deduction or a reversal larger than everything unpaid is shown
 * as the debt it is. See `EarningsSummary` in lib/rider/earnings-math.ts.
 *
 *   401 unauthenticated · 403 not_rider | feature_disabled (driver.earnings)
 *   429 · 503 migration_pending (no 0083) · 500 server_error
 */
export async function GET() {
  const gate = await riderEarningsGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    return earningsJson(await getEarningsSummary(gate.driverId));
  } catch (e) {
    return earningsRouteError(e, ROUTE, gate.driverId);
  }
}
