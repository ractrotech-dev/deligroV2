import { NextResponse } from "next/server";
import { insightsJson, insightsRouteError, riderInsightsGate } from "@/lib/auth/rider-insights-route";
import { getRiderHistoryDetail } from "@/lib/data-access/rider-insights";

const ROUTE = "/api/rider/history/[orderId]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/rider/history/:orderId - one finished delivery in full.
 *
 *   200 HistoryItem & {
 *       timeline: { kind, method, reason, at }[],   the rider's own events, accepted -> ended
 *       proofPhotoUrl: string | null,               10-minute signed link, only for a delivery this rider delivered
 *       items: { name, qty }[] }
 *   404 not_found           not an order this rider has finished (an unknown id, someone else's,
 *                           or one still in their hands answer the same)
 *   401 · 403 not_rider | feature_disabled (driver.history) · 429
 *   · 503 migration_pending (no 0081) · 500
 */
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const gate = await riderInsightsGate(ROUTE, { feature: "driver.history" });
  if (!gate.ok) return gate.response;
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const detail = await getRiderHistoryDetail(gate.driverId, orderId, { earnings: gate.earnings });
    if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return insightsJson(detail);
  } catch (e) {
    return insightsRouteError(e, ROUTE, gate.driverId);
  }
}
