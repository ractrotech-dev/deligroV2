import { cashJson, cashRouteError, riderCashGate } from "@/lib/auth/rider-cash-route";
import { getRiderCashSummary } from "@/lib/data-access/rider-cash";

const ROUTE = "/api/rider/cash/summary";

/**
 * GET /api/rider/cash/summary — the Cash screen's figures.
 *
 *   200 RiderCashSummary { toCollect, collectedToday, depositedToday,
 *       collectedTotal, depositedTotal, pending, submittedAwaiting,
 *       oldestUndepositedAt, overLimit, overHours, limit, maxHours,
 *       days: [{ day, collected, deposited, status, note }] }
 *
 * Whole rupees. `pending` = collected − deposited (confirmed handovers), never
 * below zero; `submittedAwaiting` is shown, not subtracted. `status` is
 * `settled` | `pending` | `disputed`; `note` is the manager's note on a
 * disputed deposit that day. A rider with no COD orders ever reads all zeros
 * and `days: []`. Cash collected for Deligro is not earnings and is never
 * included in them.
 *
 *   401 unauthenticated · 403 not_rider · 429 · 503 migration_pending (no 0085)
 *   · 500 server_error
 */
export async function GET() {
  const gate = await riderCashGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    return cashJson(await getRiderCashSummary(gate.driverId));
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "GET", riderId: gate.driverId, event: "cash_summary" });
  }
}
