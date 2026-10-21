/**
 * IST (Asia/Kolkata) calendar arithmetic for the ops metrics.
 *
 * India has no daylight saving, so IST is a fixed UTC+05:30 and every helper
 * here is plain integer arithmetic on that offset — no `Intl` per row, which
 * matters when a report walks five thousand orders. Day keys are
 * "YYYY-MM-DD"; a `DateRange` is inclusive at both ends.
 */
import type { DateRange, Granularity } from "./types";

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

function toMs(at: string | Date): number {
  return typeof at === "string" ? new Date(at).getTime() : at.getTime();
}

/** The IST calendar day of an instant. */
export function istDayKey(at: string | Date): string {
  return new Date(toMs(at) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST midnight starting `dayKey`, as an instant. */
export function istDayStart(dayKey: string): Date {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) - IST_OFFSET_MS);
}

/** Calendar arithmetic on a day key. */
export function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The instants a range covers: `[start, endExclusive)`. */
export function rangeBounds(range: DateRange): { start: Date; endExclusive: Date } {
  return {
    start: istDayStart(range.from),
    endExclusive: istDayStart(addDays(range.to, 1)),
  };
}

/** Does this instant fall inside the range's IST days? */
export function inRange(at: string | Date, range: DateRange): boolean {
  const day = istDayKey(at);
  return day >= range.from && day <= range.to;
}

/** Number of IST days in an inclusive range (0 when `to` precedes `from`). */
export function rangeLength(range: DateRange): number {
  const n =
    Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS) + 1;
  return Math.max(0, n);
}

/** Every day key in the range, in order. */
export function daysInRange(range: DateRange): string[] {
  const n = rangeLength(range);
  return Array.from({ length: n }, (_, i) => addDays(range.from, i));
}

/** The equally long period immediately before `range` — what growth compares against. */
export function previousPeriod(range: DateRange): DateRange {
  const n = rangeLength(range);
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
}

/** IST weekday of a day key, Monday = 0 … Sunday = 6. */
function weekdayOfDay(dayKey: string): number {
  return (new Date(`${dayKey}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * The bucket an instant falls in: the day, the Monday starting its week, the
 * month ("YYYY-MM") or the year ("YYYY") — all in IST.
 */
export function bucketKey(at: string | Date, granularity: Granularity): string {
  const day = istDayKey(at);
  switch (granularity) {
    case "day":
      return day;
    case "week":
      return addDays(day, -weekdayOfDay(day));
    case "month":
      return day.slice(0, 7);
    case "year":
      return day.slice(0, 4);
  }
}

/** Hour of day (0–23) and weekday (Monday = 0) in IST — the peak-hours grid. */
export function istHourWeekday(at: string | Date): { hour: number; weekday: number } {
  const shifted = new Date(toMs(at) + IST_OFFSET_MS);
  return {
    hour: shifted.getUTCHours(),
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

/**
 * Period-to-date ranges for the Day / Week / Month / Year filters: today, this
 * week from Monday, this month from the 1st, this year from 1 January — each
 * ending today.
 */
export function presetRange(granularity: Granularity, now: Date = new Date()): DateRange {
  const today = istDayKey(now);
  switch (granularity) {
    case "day":
      return { from: today, to: today };
    case "week":
      return { from: addDays(today, -weekdayOfDay(today)), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** A well-formed "YYYY-MM-DD" that is a real calendar date. */
export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
