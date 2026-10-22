import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { defaultMetricsRange, ticketMetrics } from "@/lib/data-access/manager-tickets";
import { addDays } from "@/lib/metrics";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/manager/tickets/metrics?from&to&zone — support performance over
 * tickets created in the range (IST dates; default the last 30 days):
 * first-response and resolution times, open tickets past the no-reply
 * threshold, counts by status / priority / requester, recurring problems
 * (top categories, vendors, riders, zones, repeat orders) and a daily series
 * (§11.10–11.11). Range at most 366 days.
 *
 * → 200 TicketMetrics   → 400 bad_request | range_too_long   → 500 load_failed
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const sp = new URL(request.url).searchParams;
  const def = defaultMetricsRange(new Date());
  const from = sp.get("from") ?? def.from;
  const to = sp.get("to") ?? def.to;
  const zone = sp.get("zone");
  if (!DAY.test(from)) return NextResponse.json({ error: "bad_request", field: "from" }, { status: 400 });
  if (!DAY.test(to) || to < from) return NextResponse.json({ error: "bad_request", field: "to" }, { status: 400 });
  if (addDays(from, 365) < to) return NextResponse.json({ error: "range_too_long" }, { status: 400 });
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });

  try {
    const metrics = await ticketMetrics(ctx.scope, { from, to }, zone ? zone.toLowerCase() : null);
    return NextResponse.json(metrics, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
