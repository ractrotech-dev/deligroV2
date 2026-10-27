import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth/cron";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { refreshZoneWeather } from "@/lib/data-access/zone-weather";
import { withCronObservability } from "@/lib/obs/cron";

/**
 * GET /api/cron/weather — reads Open-Meteo for every active delivery zone not
 * read in the last 15 minutes, and tells riders where it got worse (0178).
 * `Authorization: Bearer $CRON_SECRET`. Point an external pinger (or pg_cron +
 * pg_net) at it every 15 minutes; without one, the dispatch sweep that the
 * shop and rider screens already trigger runs the same refresh.
 */
export const dynamic = "force-dynamic";

async function run(req: Request): Promise<Response> {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseConfigured) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }
  const result = await refreshZoneWeather();
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withCronObservability("weather", run);
