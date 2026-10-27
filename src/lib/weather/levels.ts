/**
 * Weather notices per delivery zone (0178): the levels, how an Open-Meteo
 * reading becomes one, the minutes each adds to a delivery, and what customers
 * and riders are told. Pure, so the site, the server and scripts/qa share it.
 * The minutes match 0178's weather_extra_minutes().
 */
export type WeatherLevel = "clear" | "rain" | "heavy_rain" | "storm" | "heat";

export const WEATHER_LEVELS: readonly WeatherLevel[] = ["clear", "rain", "heavy_rain", "storm", "heat"];

export function isWeatherLevel(v: unknown): v is WeatherLevel {
  return typeof v === "string" && (WEATHER_LEVELS as readonly string[]).includes(v);
}

const EXTRA: Record<WeatherLevel, number> = { clear: 0, rain: 10, heavy_rain: 20, storm: 30, heat: 5 };

export function weatherExtraMinutes(level: WeatherLevel): number {
  return EXTRA[level] ?? 0;
}

/** How serious each level is, for "did it get worse?". Heat is milder than any rain. */
const RANK: Record<WeatherLevel, number> = { clear: 0, heat: 1, rain: 2, heavy_rain: 3, storm: 4 };

/** Riders are pushed when a zone's weather gets worse, once per step up. */
export function shouldTellRiders(told: WeatherLevel, now: WeatherLevel): boolean {
  return RANK[now] > RANK[told];
}

export const WEATHER_LABEL: Record<WeatherLevel, string> = {
  clear: "Clear",
  rain: "Rain",
  heavy_rain: "Heavy rain",
  storm: "Storm",
  heat: "Very hot",
};

/** Open-Meteo's `current` values, already numbers (NaN when missing). */
export interface WeatherReading {
  /** mm in the last hour. */
  precipitation: number;
  /** WMO weather code. */
  weatherCode: number;
  /** km/h. */
  gusts: number;
  /** °C. */
  temperature: number;
}

/** A missing number never raises a warning: it reads as nothing happening. */
export function levelFromReading(r: WeatherReading): WeatherLevel {
  const n = (v: number) => (Number.isFinite(v) ? v : 0);
  const code = n(r.weatherCode);
  if ((code >= 95 && code <= 99) || n(r.gusts) >= 60) return "storm";
  if (n(r.precipitation) >= 7.6) return "heavy_rain";
  if (n(r.precipitation) >= 0.5) return "rain";
  if (n(r.temperature) >= 43) return "heat";
  return "clear";
}

export function customerWeatherText(level: WeatherLevel, zone: string): string {
  switch (level) {
    case "rain":
      return `Rain in ${zone}: deliveries may take about 10 minutes longer.`;
    case "heavy_rain":
      return `Heavy rain in ${zone}: deliveries may take about 20 minutes longer.`;
    case "storm":
      return `Storm in ${zone}: deliveries may take about 30 minutes longer.`;
    case "heat":
      return `Very hot in ${zone}: deliveries may take a little longer.`;
    default:
      return "";
  }
}

export function riderWeatherText(level: WeatherLevel, zone: string): { title: string; body: string } {
  switch (level) {
    case "rain":
      return { title: `Rain in ${zone}`, body: "Ride carefully. Customers have been told to expect delays." };
    case "heavy_rain":
      return { title: `Heavy rain in ${zone}`, body: "Slow down, roads are wet. Ride carefully; customers have been told to expect delays." };
    case "storm":
      return { title: `Storm in ${zone}`, body: "Take shelter if it is unsafe to ride. Customers have been told to expect delays." };
    case "heat":
      return { title: `Very hot in ${zone}`, body: "Drink water and take short breaks in the shade." };
    default:
      return { title: "", body: "" };
  }
}

/** Minutes for a shop's zone from the zones with weather now (zone id → minutes). */
export function weatherMinutesFor(byZone: ReadonlyMap<string, number>, zoneId: string | null | undefined): number {
  return zoneId ? byZone.get(zoneId) ?? 0 : 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WeatherOverride {
  zoneId: string;
  /** "auto" goes back to the automatic reading. */
  level: WeatherLevel | "auto";
  /** 1–12; null with "auto". */
  hours: number | null;
  note: string | null;
  clientActionId: string;
}

/** The manager's override (POST /api/manager/weather). */
export function parseWeatherOverride(b: Record<string, unknown> | null): { ok: true; value: WeatherOverride } | { ok: false; field: string } {
  if (!b) return { ok: false, field: "body" };
  if (typeof b.zoneId !== "string" || !UUID.test(b.zoneId)) return { ok: false, field: "zoneId" };
  if (typeof b.clientActionId !== "string" || !UUID.test(b.clientActionId)) return { ok: false, field: "clientActionId" };
  const level = b.level;
  if (level !== "auto" && !isWeatherLevel(level)) return { ok: false, field: "level" };
  let hours: number | null = null;
  if (level !== "auto") {
    if (typeof b.hours !== "number" || !Number.isInteger(b.hours) || b.hours < 1 || b.hours > 12) return { ok: false, field: "hours" };
    hours = b.hours;
  }
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  if (note && note.length > 200) return { ok: false, field: "note" };
  return { ok: true, value: { zoneId: b.zoneId.toLowerCase(), level, hours, note, clientActionId: b.clientActionId.toLowerCase() } };
}
