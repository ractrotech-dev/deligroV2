import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid, narrowScope } from "@/lib/auth/manager-scope";
import { vendorInScope } from "@/lib/data-access/manager-vendors";
import { loadShopNames, loadStatsRollups } from "@/lib/data-access/ops-metrics";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { parseStatsQuery } from "@/lib/manager/stats-query";
import { statsPayloadFromRollups } from "@/lib/manager/stats-payload";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/stats?granularity=day|week|month|year|custom&from&to&zone
 * &vendor — business statistics and growth (§2). Needs `manager.reports.view`;
 * with `vendor` (one shop in the caller's scope, else 404) also
 * `manager.vendors.view`, and every figure is that shop's (§4.9).
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

  const vendorRaw = new URL(request.url).searchParams.get("vendor");
  let vendor: string | null = null;
  if (vendorRaw) {
    if (ctx.permissions["manager.vendors.view"] !== true) {
      return NextResponse.json({ error: "permission_denied", permission: "manager.vendors.view" }, { status: 403 });
    }
    if (!isUuid(vendorRaw)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    vendor = vendorRaw.toLowerCase();
  }

  try {
    if (vendor && !(await vendorInScope(scope, vendor))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const rollups = await loadStatsRollups(scope, q.range, q.previous, vendor);
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
