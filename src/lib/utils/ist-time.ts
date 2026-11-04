/**
 * India (Asia/Kolkata) calendar helpers for vendor analytics windows.
 * Server default TZ is often UTC (Vercel); UI is en-IN.
 */

const IST = "Asia/Kolkata";

/** YYYY-MM-DD in IST for a given instant. */
export function istDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: IST });
}

/** Start of the IST calendar day containing `d`, as a UTC Date. */
export function startOfIstDay(d = new Date()): Date {
  return new Date(`${istDateKey(d)}T00:00:00+05:30`);
}

/** Start of the IST week (Monday) containing `d`. */
export function startOfIstWeek(d = new Date()): Date {
  const start = startOfIstDay(d);
  // getDay() in local — use IST weekday via formatter
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "short",
  }).format(d);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const offset = map[weekday] ?? 0;
  start.setTime(start.getTime() - offset * 24 * 60 * 60 * 1000);
  return start;
}

/** Start of the IST calendar month containing `d`. */
export function startOfIstMonth(d = new Date()): Date {
  const key = istDateKey(d);
  const [y, m] = key.split("-").map(Number);
  return new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+05:30`);
}

/** Add calendar days to an IST-midnight Date. */
export function addIstDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setTime(next.getTime() + days * 24 * 60 * 60 * 1000);
  return next;
}

/**
 * Format an instant for display in India time, whatever zone the code runs in.
 *
 * `toLocaleString("en-IN", …)` without a `timeZone` formats in the *runtime's*
 * zone, and server components run in UTC on Vercel — so a receipt rendered on
 * the server printed "7:42 am" for an order placed at 1:12 pm IST. The `en-IN`
 * locale only picks the wording, never the clock. Every customer-facing
 * timestamp goes through here so the server and the phone agree.
 */
export function formatIst(
  d: Date | string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-IN", { ...options, timeZone: IST });
}

/** Whole IST calendar days from `from` to `to` (0 = same IST day). */
export function istDaysBetween(from: Date, to: Date): number {
  const a = new Date(`${istDateKey(from)}T00:00:00+05:30`).getTime();
  const b = new Date(`${istDateKey(to)}T00:00:00+05:30`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** "2030-01-05T09:30" or with seconds: the shape a `datetime-local` input sends. */
const IST_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * A `datetime-local` value typed in IST ("2030-01-05T09:30") as an instant.
 * Blank is null (now / no end); anything unreadable is passed through so a
 * strict parser downstream refuses it.
 *
 * Never `new Date(value)`: that reads the text in the server's zone, which is
 * UTC on Vercel, and lands 5.5 hours late.
 */
export function istLocalToIso(value: string | null): string | null {
  if (!value) return null;
  if (!IST_LOCAL.test(value)) return value;
  const t = Date.parse(`${value.length === 16 ? `${value}:00` : value}+05:30`);
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
}

/** The same, for a form field: blank or unreadable is null. */
export function istInputToIso(raw: unknown): string | null {
  if (typeof raw !== "string" || !IST_LOCAL.test(raw.trim())) return null;
  const iso = istLocalToIso(raw.trim());
  return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * An instant as the value a `datetime-local` input shows, in IST, whatever zone
 * the browser or server is in. The exact inverse of `istInputToIso`, so saving a
 * form without touching its dates keeps them to the minute. India has no daylight
 * saving, so a fixed offset is correct all year.
 */
export function isoToIstLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t + 330 * 60_000).toISOString().slice(0, 16);
}
