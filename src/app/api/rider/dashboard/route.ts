import { insightsJson, insightsRouteError, riderInsightsGate } from "@/lib/auth/rider-insights-route";
import { getRiderDashboard } from "@/lib/data-access/rider-insights";
import { isFeatureOn } from "@/lib/features/flags.server";

const ROUTE = "/api/rider/dashboard";

/**
 * GET /api/rider/dashboard - Home's twelve figures. The app refreshes it every
 * 15 s while Home is visible, on resume and after any action.
 *
 *   200 RiderDashboard {
 *     today: { deliveries, pending, accepted, pickedUp, completed, cancelled, failed },
 *     money: { today, total, pending, incentivesThisWeek } | null,
 *     availability: { isOnline, breakUntil, onlineSince, lastFixAt },
 *     phase: "offline" | "online" | "break" | "stale",
 *     current: { orderId, code, status, next } | null,
 *     nearestTarget: { name, done, target, bonus } | null,
 *     updatedAt }
 *
 * IST days. `deliveries` = accepted today; `completed` = delivered today;
 * `cancelled` = today's accepted deliveries that ended cancelled, failed or
 * were reassigned away (`failed` is the failed part of it); `pending` = offers
 * held for the rider now; `accepted` / `pickedUp` = their current state.
 * `money` and `nearestTarget` are null when `driver.earnings` is off for the
 * rider (the ledger is not read at all) or before migration 0083.
 * `nearestTarget` is also null when `driver.incentives` is off: the incentive
 * targets are hidden in the app and the server does not send them either.
 *
 *   401 unauthenticated · 403 not_rider · 429 · 503 migration_pending (no 0081)
 *   · 500 server_error
 */
export async function GET() {
  const gate = await riderInsightsGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    const [dashboard, incentives] = await Promise.all([
      getRiderDashboard(gate.driverId, new Date(), { earnings: gate.earnings }),
      isFeatureOn("driver.incentives", gate.driverId),
    ]);
    return insightsJson(incentives ? dashboard : { ...dashboard, nearestTarget: null });
  } catch (e) {
    return insightsRouteError(e, ROUTE, gate.driverId);
  }
}
