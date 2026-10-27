import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { scopeZoneIds } from "@/lib/auth/manager-scope";
import { listZoneWeather, tellRidersAboutWeather } from "@/lib/data-access/zone-weather";
import { mapRpcError } from "@/lib/ops/order-actions";
import { deferNotify } from "@/lib/notifications/defer";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseWeatherOverride } from "@/lib/weather/levels";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/weather — the weather of each zone this manager works in
 * (0178): what customers and riders are told now, the automatic reading, and
 * any override.
 * → 200 { zones: ZoneWeatherDetail[] }
 */
export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  try {
    return NextResponse.json({ zones: await listZoneWeather(scopeZoneIds(ctx.scope)) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/manager/weather — { zoneId, level, hours?, note?, clientActionId }:
 * set a zone's weather for 1–12 hours (it adds to delivery times and is shown
 * to customers and riders), or level "auto" to go back to the automatic
 * reading. Riders are told when it gets worse. manager.weather.manage.
 * → 200 { zones }   → 400 bad_request   → 403   → 404 not_found   → 429
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.weather.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "weather", 20);
  if (limited) return limited;
  const parsed = parseWeatherOverride(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });
  const zones = scopeZoneIds(ctx.scope);
  if (zones !== null && !zones.includes(parsed.value.zoneId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const v = parsed.value;
  try {
    const { error } = await createAdminClient().rpc("ops_set_zone_weather", {
      p_actor: ctx.profile.id,
      p_zone: v.zoneId,
      p_level: v.level,
      p_hours: v.hours,
      p_note: v.note,
      p_client_action_id: v.clientActionId,
    });
    if (error) {
      const r = mapRpcError(error as { code?: string; message?: string; details?: string | null });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    }
    deferNotify(() => tellRidersAboutWeather());
    return NextResponse.json({ zones: await listZoneWeather(zones) });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
