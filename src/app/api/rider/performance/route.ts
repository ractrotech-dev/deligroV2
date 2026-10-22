import { insightsJson, insightsRouteError, riderInsightsGate } from "@/lib/auth/rider-insights-route";
import { getRiderPerformance } from "@/lib/data-access/rider-insights";

const ROUTE = "/api/rider/performance";

/**
 * GET /api/rider/performance - targets, times, rates, hours online, ratings
 * and the month-by-month report.
 *
 *   200 RiderPerformance {
 *     daily: { target, done }, weekly: { target, done },   target 0 = none to show
 *     avgAcceptToDeliverMin, avgPickupToDeliverMin,         minutes, delivered jobs only
 *     acceptanceRate, failedRate,                           percent 0-100, null when nothing to divide
 *     onlineHoursThisWeek,
 *     rating: { average, count, recent: { rating, comment, at }[] },   never who rated
 *     months: { month, delivered, failed, cancelled, acceptanceRate, avgDeliverMin, earnings, onlineHours }[] }
 *
 * IST days; the week starts Monday. The averages and rates look back the last
 * 30 days; `months` is the last 12, newest first (`YYYY-MM`; `cancelled`
 * includes reassigned away). `earnings` per month is the recorded ledger total
 * (null when nothing was recorded, `driver.earnings` is off, or before 0083).
 * Before 0084 the rating block is empty.
 *
 *   401 unauthenticated · 403 not_rider · 429 · 503 migration_pending (no 0081) · 500
 */
export async function GET() {
  const gate = await riderInsightsGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    return insightsJson(await getRiderPerformance(gate.driverId, new Date(), { earnings: gate.earnings }));
  } catch (e) {
    return insightsRouteError(e, ROUTE, gate.driverId);
  }
}
