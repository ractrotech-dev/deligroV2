import { earningsJson, earningsRouteError, riderEarningsGate } from "@/lib/auth/rider-earnings-route";
import { getEarningsSummary } from "@/lib/data-access/rider-earnings";
import { riderPaySummary } from "@/lib/rider/earnings-math";

const ROUTE = "/api/rider/earnings/summary";

/**
 * GET /api/rider/earnings/summary — the Salary tab's figures.
 *
 *   200 RiderPaySummary { salary, adjustments, deductions, olderPay, paid,
 *       pending, lastPayout }
 *
 * Riders get a fixed salary only (rule book). `olderPay` is what old ledger rows
 * add up to, under one neutral name. `pending` may be negative: a deduction
 * larger than everything unpaid is shown as the debt it is. See
 * `riderPaySummary` in lib/rider/earnings-math.ts.
 *
 *   401 unauthenticated · 403 not_rider | feature_disabled (driver.earnings)
 *   429 · 503 migration_pending (no 0083) · 500 server_error
 */
export async function GET() {
  const gate = await riderEarningsGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    return earningsJson(riderPaySummary(await getEarningsSummary(gate.driverId)));
  } catch (e) {
    return earningsRouteError(e, ROUTE, gate.driverId);
  }
}
