import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { notifyUsers } from "@/lib/notifications/notify-user";
import {
  customerWeatherText,
  isWeatherLevel,
  levelFromReading,
  ratePerHour,
  riderWeatherText,
  shouldTellRiders,
  type WeatherLevel,
} from "@/lib/weather/levels";

/**
 * Weather per delivery zone (0178): what it is now, the automatic reading from
 * Open-Meteo, and telling riders when it gets worse.
 *
 * Every read here fails quiet: weather is a courtesy on top of delivery
 * times, so a missing migration or an outage means "no weather", never a
 * broken page or a wrong warning.
 */

export interface ZoneWeatherNow {
  zoneId: string;
  zoneName: string;
  level: WeatherLevel;
  extraMinutes: number;
  source: "auto" | "manual";
  until: string | null;
}

/** Zones with weather right now (clear zones are left out). Once per request. */
export const getZoneWeatherNow = cache(async (): Promise<ZoneWeatherNow[]> => {
  if (!isSupabaseConfigured) return [];
  try {
    const { data, error } = await createAdminClient().rpc("zone_weather_now");
    if (error || !Array.isArray(data)) return [];
    return (data as { zone_id: string; zone_name: string; level: string; extra_minutes: number; source: string; until: string | null }[])
      .filter((r) => isWeatherLevel(r.level))
      .map((r) => ({
        zoneId: r.zone_id,
        zoneName: r.zone_name,
        level: r.level as WeatherLevel,
        extraMinutes: Number(r.extra_minutes) || 0,
        source: r.source === "manual" ? "manual" : "auto",
        until: r.until,
      }));
  } catch {
    return [];
  }
});

/** Zone id → extra delivery minutes, for the delivery-time maths. */
export async function weatherMinutesByZone(): Promise<Map<string, number>> {
  return new Map((await getZoneWeatherNow()).map((w) => [w.zoneId, w.extraMinutes]));
}

/** A zone's own row for the manager screen: the reading and any override. */
export interface ZoneWeatherDetail {
  zoneId: string;
  zoneName: string;
  level: WeatherLevel;
  autoLevel: WeatherLevel;
  autoDetail: string | null;
  autoCheckedAt: string | null;
  manualLevel: WeatherLevel | null;
  manualUntil: string | null;
  manualNote: string | null;
}

export async function listZoneWeather(zoneIds: readonly string[] | null): Promise<ZoneWeatherDetail[]> {
  const db = createAdminClient();
  let zq = db.from("delivery_zones").select("id, name").eq("is_active", true).order("name");
  if (zoneIds) zq = zq.in("id", zoneIds.length ? [...zoneIds] : ["00000000-0000-0000-0000-000000000000"]);
  const [{ data: zones, error }, now, { data: rows }] = await Promise.all([
    zq,
    getZoneWeatherNow(),
    db.from("zone_weather").select("zone_id, auto_level, auto_detail, auto_checked_at, manual_level, manual_until, manual_note"),
  ]);
  if (error) throw error;
  const byZone = new Map(
    ((rows ?? []) as {
      zone_id: string; auto_level: string; auto_detail: string | null; auto_checked_at: string | null;
      manual_level: string | null; manual_until: string | null; manual_note: string | null;
    }[]).map((r) => [r.zone_id, r])
  );
  const nowByZone = new Map(now.map((w) => [w.zoneId, w]));
  return ((zones ?? []) as { id: string; name: string }[]).map((z) => {
    const r = byZone.get(z.id);
    const manualLive = !!r?.manual_until && Date.parse(r.manual_until) > Date.now() && isWeatherLevel(r.manual_level);
    return {
      zoneId: z.id,
      zoneName: z.name,
      level: nowByZone.get(z.id)?.level ?? "clear",
      autoLevel: isWeatherLevel(r?.auto_level) ? r!.auto_level as WeatherLevel : "clear",
      autoDetail: r?.auto_detail ?? null,
      autoCheckedAt: r?.auto_checked_at ?? null,
      manualLevel: manualLive ? (r!.manual_level as WeatherLevel) : null,
      manualUntil: manualLive ? r!.manual_until : null,
      manualNote: manualLive ? r!.manual_note : null,
    };
  });
}

// ── the automatic reading ────────────────────────────────────────────────────

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
/** Each zone is read at most this often. */
const REFRESH_MS = 15 * 60_000;

async function readOpenMeteo(lat: number, lng: number): Promise<{ level: WeatherLevel; detail: string } | null> {
  const url = `${OPEN_METEO}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=precipitation,weather_code,wind_gusts_10m,temperature_2m&timezone=UTC`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { current?: Record<string, unknown> };
    const c = json.current ?? {};
    const num = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : Number.NaN);
    const reading = {
      precipitation: ratePerHour(num("precipitation"), num("interval")),
      weatherCode: num("weather_code"),
      gusts: num("wind_gusts_10m"),
      temperature: num("temperature_2m"),
    };
    return {
      level: levelFromReading(reading),
      detail: `${Math.round(reading.precipitation * 10) / 10} mm/h, code ${reading.weatherCode}, gusts ${reading.gusts} km/h, ${reading.temperature} °C`,
    };
  } catch {
    return null;
  }
}

/**
 * Reads Open-Meteo for every active zone not read in the last 15 minutes, then
 * tells riders where it got worse. Safe to call often: the throttle is the
 * stored reading time, so many servers calling it at once read each zone about
 * once. A failed read leaves the last one to age out (0178: 3 hours).
 */
export async function refreshZoneWeather(opts: { force?: boolean } = {}): Promise<{ read: number; told: number }> {
  if (!isSupabaseConfigured) return { read: 0, told: 0 };
  const db = createAdminClient();
  const [{ data: zones }, { data: rows, error }] = await Promise.all([
    db.from("delivery_zones").select("id, center_lat, center_lng").eq("is_active", true),
    db.from("zone_weather").select("zone_id, auto_checked_at"),
  ]);
  if (error) return { read: 0, told: 0 }; // 0178 not applied yet.
  const checked = new Map(((rows ?? []) as { zone_id: string; auto_checked_at: string | null }[]).map((r) => [r.zone_id, r.auto_checked_at]));
  const due = ((zones ?? []) as { id: string; center_lat: number; center_lng: number }[]).filter((z) => {
    const at = checked.get(z.id);
    return opts.force || !at || Date.now() - Date.parse(at) >= REFRESH_MS;
  });
  let read = 0;
  for (const z of due) {
    const r = await readOpenMeteo(Number(z.center_lat), Number(z.center_lng));
    if (!r) continue;
    const { error: e } = await db.rpc("set_zone_weather_auto", { p_zone: z.id, p_level: r.level, p_detail: r.detail });
    if (!e) read += 1;
  }
  const told = await tellRidersAboutWeather();
  return { read, told };
}

let lastTry = 0;

/**
 * The refresh, at most once a minute per server instance. Awaited by its
 * caller, which already runs after the response (the dispatch sweep in
 * `after()`): a promise left running there can be frozen before the reading
 * or the rider push lands.
 */
export async function maybeRefreshZoneWeather(): Promise<void> {
  const now = Date.now();
  if (now - lastTry < 60_000) return;
  lastTry = now;
  await refreshZoneWeather().catch(() => undefined);
}

/**
 * One push + inbox line to the zone's riders when its weather got worse than
 * what they were last told; an easing is recorded quietly so the next rise is
 * told again. Two servers racing push once (0178 zone_weather_mark_notified).
 */
export async function tellRidersAboutWeather(): Promise<number> {
  const db = createAdminClient();
  const [now, { data: rows, error }] = await Promise.all([
    getZoneWeatherNowFresh(),
    db.from("zone_weather").select("zone_id, notified_level"),
  ]);
  if (error) return 0;
  const levels = new Map(now.map((w) => [w.zoneId, w]));
  let told = 0;
  for (const r of (rows ?? []) as { zone_id: string; notified_level: string }[]) {
    const w = levels.get(r.zone_id);
    const level: WeatherLevel = w?.level ?? "clear";
    const was: WeatherLevel = isWeatherLevel(r.notified_level) ? r.notified_level : "clear";
    if (level === was) continue;
    const { data: moved } = await db.rpc("zone_weather_mark_notified", { p_zone: r.zone_id, p_level: level });
    if (moved !== true || !shouldTellRiders(was, level) || !w) continue;
    const { data: staff } = await db.from("staff_zones").select("user_id, profiles!staff_zones_user_id_fkey!inner(role)").eq("zone_id", r.zone_id).eq("profiles.role", "driver");
    const riders = ((staff ?? []) as { user_id: string }[]).map((s) => ({ userId: s.user_id, role: "rider" as const }));
    if (riders.length === 0) continue;
    const text = riderWeatherText(level, w.zoneName);
    // Safety: always pushed, whatever the rider muted.
    await notifyUsers(riders, { category: "safety", title: text.title, body: text.body, url: "/" });
    told += 1;
  }
  return told;
}

/** Uncached: a refresh in the same request has just written new readings. */
async function getZoneWeatherNowFresh(): Promise<ZoneWeatherNow[]> {
  const { data, error } = await createAdminClient().rpc("zone_weather_now");
  if (error || !Array.isArray(data)) return [];
  return (data as { zone_id: string; zone_name: string; level: string; extra_minutes: number; source: string; until: string | null }[])
    .filter((r) => isWeatherLevel(r.level))
    .map((r) => ({
      zoneId: r.zone_id,
      zoneName: r.zone_name,
      level: r.level as WeatherLevel,
      extraMinutes: Number(r.extra_minutes) || 0,
      source: r.source === "manual" ? "manual" : "auto",
      until: r.until,
    }));
}

/**
 * Shop id → extra minutes for the weather in its zone. Costs nothing while no
 * zone has weather (the usual case); otherwise one zone lookup for the shops.
 */
export async function weatherMinutesForShops(shopIds: string[]): Promise<Map<string, number>> {
  const byZone = await weatherMinutesByZone();
  if (byZone.size === 0 || shopIds.length === 0) return new Map();
  try {
    const { data, error } = await createAdminClient().from("restaurants").select("id, zone_id").in("id", shopIds);
    if (error) return new Map();
    return new Map(((data ?? []) as { id: string; zone_id: string | null }[]).map((r) => [r.id, r.zone_id ? byZone.get(r.zone_id) ?? 0 : 0]));
  } catch {
    return new Map();
  }
}

/** What the customer is told on tracking when the shop's zone has weather (0178), or null. */
export async function weatherLineForShop(shopId: string): Promise<string | null> {
  const now = await getZoneWeatherNow();
  if (now.length === 0) return null;
  try {
    const { data } = await createAdminClient().from("restaurants").select("zone_id").eq("id", shopId).maybeSingle();
    const zone = (data as { zone_id: string | null } | null)?.zone_id;
    const w = now.find((x) => x.zoneId === zone);
    return w ? customerWeatherText(w.level, w.zoneName) || null : null;
  } catch {
    return null;
  }
}

/** The weather notices for a rider's zones, for the rider home screen. */
export async function weatherForRider(driverId: string): Promise<{ zone: string; level: WeatherLevel; title: string; body: string }[]> {
  const now = await getZoneWeatherNow();
  if (now.length === 0) return [];
  try {
    const { data } = await createAdminClient().from("staff_zones").select("zone_id").eq("user_id", driverId);
    const mine = new Set(((data ?? []) as { zone_id: string }[]).map((r) => r.zone_id));
    return now.filter((w) => mine.has(w.zoneId)).map((w) => ({ zone: w.zoneName, level: w.level, ...riderWeatherText(w.level, w.zoneName) }));
  } catch {
    return [];
  }
}
