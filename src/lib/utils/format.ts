import { translator, type Lang } from "@/lib/i18n/lang";

/** Money & display formatting helpers. Prices are stored as whole rupees. */

export function formatINR(amount: number): string {
  return "₹" + amount.toLocaleString("en-IN");
}

/**
 * "12 min late", "3 h late", "23 days late". A stuck order used to read
 * "33927 min late" — a number nobody can picture.
 */
export function formatLateness(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min late`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h late`;
  const d = Math.round(m / 1440);
  return `${d} ${d === 1 ? "day" : "days"} late`;
}

/**
 * Past this, a lateness figure stops being information for the customer and
 * becomes an accusation: "27 days late · Accepted" is what a stuck order read
 * on the customer's own Orders screen in the 28 Sept live test. Ops is pushed
 * about it (lib/dispatch/sweep.ts); the customer is told a person is on it.
 */
export const CUSTOMER_LATE_CAP_MINUTES = 180;

/**
 * Customer-facing lateness, in the customer's language. Exact up to the cap,
 * then a plain "delayed" — never "27 days late". Operator screens keep the
 * exact figure (`formatLateness`), because for them the number is the point.
 */
export function formatCustomerLateness(minutes: number, lang: Lang = "en"): string {
  const t = translator(lang);
  const m = Math.max(0, Math.round(minutes));
  if (m >= CUSTOMER_LATE_CAP_MINUTES) return t("Delayed — we're on it", "देरी — हम देख रहे हैं");
  if (m < 60) return t(`${m} min late`, `${m} मिनट देर`);
  const h = Math.round(m / 60);
  return t(`${h} h late`, `${h} घंटे देर`);
}

export function formatRating(rating: number): string {
  return rating.toFixed(1);
}

/**
 * Has anybody actually rated this?
 *
 * `restaurants.rating` and `rating_count` both default to 0, so a kitchen
 * nobody has reviewed arrives as a real, comparable zero — and every surface
 * that formatted it printed "★ 0.0", which is not an absence of a rating, it
 * is the worst one there is. On the search results that put a damning number
 * beside every new shop on the platform.
 *
 * The same rule the tracking screen already applies to riders ("we don't rate
 * riders yet — undefined is unknown, never a flattering guess"): unknown is its
 * own answer and gets its own word, never a number we did not measure.
 *
 * `rating > 0` as well as `count > 0`, because the two columns are written
 * independently and a count without a score is as unusable as a score without a
 * count.
 */
export function isRated(rating: number, count: number): boolean {
  return count > 0 && rating > 0;
}

export function formatCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** e.g. "22–28 min" */
export function formatEta(min: number, max: number): string {
  return `${min}–${max} min`;
}

/**
 * "Gaurav Mirjha" → "GM", for avatar tiles. Falls back to a single letter and
 * then to "A" — an avatar chip with nothing in it reads as a rendering fault.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const last = parts.at(-1) ?? "";
  return (parts[0][0] + last[0]).toUpperCase();
}

/**
 * "3d 4h", "5h", "20m" — how long something has been waiting. Coarse on
 * purpose: an approval queue is scanned, not read, and "3d" carries the whole
 * decision where "3d 4h 12m" just costs a column.
 */
export function formatWaited(sinceIso: string, now = Date.now()): string {
  const ms = now - new Date(sinceIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem ? `${days}d ${rem}h` : `${days}d`;
}
