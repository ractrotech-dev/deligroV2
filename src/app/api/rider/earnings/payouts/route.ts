import { earningsJson, earningsRouteError, riderEarningsGate } from "@/lib/auth/rider-earnings-route";
import { listPayouts } from "@/lib/data-access/rider-earnings";

const ROUTE = "/api/rider/earnings/payouts";

/**
 * GET /api/rider/earnings/payouts — every payout made to the rider, newest
 * first, with how many records each one settled.
 *
 *   200 { payouts: { id, amount, method, reference, paidOn, periodEnd, items }[] }
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 */
export async function GET() {
  const gate = await riderEarningsGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    return earningsJson({ payouts: await listPayouts(gate.driverId) });
  } catch (e) {
    return earningsRouteError(e, ROUTE, gate.driverId);
  }
}
