/**
 * The statistics screen's period (§2.2–2.4): Day / Week / Month / Year — each
 * from the start of the current period to today — or a custom range, always
 * compared with the equal-length period just before it. Pure.
 */
import { isDayKey, istDayKey, presetRange, previousPeriod, rangeLength } from "@/lib/metrics/ist";
import type { DateRange, Granularity } from "@/lib/metrics/types";

export type StatsGranularity = Granularity | "custom";

export type StatsQueryError =
  | "bad_granularity"
  | "bad_date"
  | "range_reversed"
  | "range_too_long"
  | "range_in_future";

export interface StatsQuery {
  granularity: StatsGranularity;
  range: DateRange;
  previous: DateRange;
  zone: string | null;
}

/** A year and a day: room for a leap year, not for an accidental decade. */
export const MAX_RANGE_DAYS = 366;

const PRESETS: readonly Granularity[] = ["day", "week", "month", "year"];

export function parseStatsQuery(
  params: URLSearchParams,
  now: Date
): ({ ok: true } & StatsQuery) | { ok: false; error: StatsQueryError } {
  const raw = params.get("granularity") || "month";
  const zone = params.get("zone") || null;

  if (raw !== "custom") {
    if (!PRESETS.includes(raw as Granularity)) return { ok: false, error: "bad_granularity" };
    const range = presetRange(raw as Granularity, now);
    return { ok: true, granularity: raw as Granularity, range, previous: previousPeriod(range), zone };
  }

  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!isDayKey(from) || !isDayKey(to)) return { ok: false, error: "bad_date" };
  if (from > to) return { ok: false, error: "range_reversed" };
  if (to > istDayKey(now)) return { ok: false, error: "range_in_future" };
  const range = { from, to };
  if (rangeLength(range) > MAX_RANGE_DAYS) return { ok: false, error: "range_too_long" };
  return { ok: true, granularity: "custom", range, previous: previousPeriod(range), zone };
}
