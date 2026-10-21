import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { narrowScope } from "@/lib/auth/manager-scope";
import { loadShopNames, loadStatsRollups } from "@/lib/data-access/ops-metrics";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { parseStatsQuery } from "@/lib/manager/stats-query";
import { statsPayloadFromRollups } from "@/lib/manager/stats-payload";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/stats?granularity=day|week|month|year|custom&from&to&zone
 * — business statistics and growth (§2). Needs `manager.reports.view`.
 *
 * → 200 StatsPayload (src/lib/manager/stats-payload.ts)
 *   400 { error: bad_granularity | bad_date | range_reversed | range_too_long | range_in_future }
 *   401 / 403 as managerApiContext; 500 load_failed
 *
 * Read-only. The period and the one before it are summed in Postgres
 * (`ops_stats_rollup`, 0144), limited to the caller's zones (or one of them),
 * and shared for 20 s between callers asking the same question. Rate-limited
 * per user, 30 a minute.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.reports.view");
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`manager-stats:${ctx.profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const now = new Date();
  const q = parseStatsQuery(new URL(request.url).searchParams, now);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400 });
  const scope = narrowScope(ctx.scope, q.zone);

  try {
    const rollups = await loadStatsRollups(scope, q.range, q.previous);
    const [shops, zones] = await Promise.all([
      loadShopNames((rollups.current.byVendor ?? []).map((v) => v.restaurantId)),
      listCitiesWithZones(),
    ]);
    return NextResponse.json(
      statsPayloadFromRollups(rollups.current, rollups.previous, q, {
        canSeeFinance: ctx.permissions["manager.finance.view"] === true,
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
