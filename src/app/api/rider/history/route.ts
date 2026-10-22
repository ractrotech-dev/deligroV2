import { insightsJson, insightsRouteError, riderInsightsGate } from "@/lib/auth/rider-insights-route";
import { getRiderHistory } from "@/lib/data-access/rider-insights";
import type { HistoryOutcome } from "@/lib/rider/figures";

const ROUTE = "/api/rider/history";

/**
 * GET /api/rider/history?from=YYYY-MM-DD&to=YYYY-MM-DD&outcome=…&cursor=…
 *
 * Every delivery the rider finished - delivered, failed, cancelled, reassigned
 * away - newest first, 20 a page by keyset (a delivery landing at the top never
 * shifts the next page). In-flight deliveries are on Jobs. `from`/`to` are IST
 * days on which the job ENDED, either or both (both: at most 366 days apart);
 * `outcome` is delivered | failed | cancelled | reassigned; `cursor` is the
 * previous page's `nextCursor`.
 *
 *   200 { items: HistoryItem[], nextCursor: string | null }
 *     HistoryItem { orderId, code, shop, dropArea, outcome, acceptedAt,
 *       pickedUpAt, deliveredAt, endedAt, distanceKm, earning, reason,
 *       cancelledBy, proof, itemCount, orderValue }
 *   `earning` is a ledger amount, or null (a ₹0 earning, none recorded, or
 *   `driver.earnings` off for the rider).
 *
 *   400 invalid_date | invalid_range | invalid_outcome | invalid_cursor
 *   401 · 403 not_rider | feature_disabled (driver.history) · 429
 *   · 503 migration_pending (no 0081) · 500
 */
export async function GET(request: Request) {
  const gate = await riderInsightsGate(ROUTE, { feature: "driver.history" });
  if (!gate.ok) return gate.response;
  const q = new URL(request.url).searchParams;
  try {
    return insightsJson(
      await getRiderHistory(
        gate.driverId,
        {
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
          outcome: (q.get("outcome") ?? undefined) as HistoryOutcome | undefined,
          cursor: q.get("cursor"),
        },
        { earnings: gate.earnings }
      )
    );
  } catch (e) {
    return insightsRouteError(e, ROUTE, gate.driverId);
  }
}
