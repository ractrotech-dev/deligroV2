import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { narrowScope } from "@/lib/auth/manager-scope";
import { loadMetricOrders, loadRefunds, loadShopNames } from "@/lib/data-access/ops-metrics";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { parseStatsQuery } from "@/lib/manager/stats-query";
import { statsPayload } from "@/lib/manager/stats-payload";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/stats?granularity=day|week|month|year|custom&from&to&zone
 * — business statistics and growth (§2). Needs `manager.reports.view`.
 *
 * → 200 StatsPayload (src/lib/manager/stats-payload.ts)
 *   400 { error: bad_granularity | bad_date | range_reversed | range_too_long | range_in_future }
 *   401 / 403 as managerApiContext; 500 load_failed
 *
 * Read-only; one load of the orders across the period and the one before it,
 * limited to the caller's zones (or one of them).
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.reports.view");
  if (ctx instanceof Response) return ctx;

  const now = new Date();
  const q = parseStatsQuery(new URL(request.url).searchParams, now);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
  const scope = narrowScope(ctx.scope, q.zone);

  try {
    const orders = await loadMetricOrders(scope, {
      range: { from: q.previous.from, to: q.range.to },
      withItems: true,
    });
    const [refunds, shops, zones] = await Promise.all([
      loadRefunds(orders.map((o) => o.id)),
      loadShopNames(orders.map((o) => o.restaurantId)),
      listCitiesWithZones(),
    ]);
    return NextResponse.json(
      statsPayload(orders, refunds, q, {
        now,
        vendorNames: shops.names,
        vendorRatings: shops.ratings,
        zones,
      })
    );
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
