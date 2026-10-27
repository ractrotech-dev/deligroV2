/**
 * How long a shop is currently telling customers it will take.
 *
 * `eta_min`/`eta_max` are free text a vendor types once when they set the store
 * up. That made the pre-purchase promise the stale half of an otherwise careful
 * ETA model: a kitchen with forty tickets on the rail at Friday dinner still
 * advertised "22–28 min" on every search card, and the customer discovered the
 * truth only after ordering, from `computeOrderEta`'s honest per-stage
 * re-anchoring.
 *
 * The bump (migration 0036) is the vendor's answer to that — "+15 minutes for
 * the next hour" — and it expires by itself, so it is not one more switch
 * someone has to remember to turn off.
 *
 * Pure and client-safe: the same function decides the number on the card, the
 * number in the vendor's own preview, and the number the server stores.
 */

export interface KitchenPaceInput {
  etaMin?: number | null;
  etaMax?: number | null;
  /** `restaurants.busy_until`. */
  busyUntil?: string | null;
  /** `restaurants.busy_extra_minutes`. */
  busyExtraMinutes?: number | null;
  /** The shop's zone weather (0178, src/lib/weather/levels.ts). */
  weatherExtraMinutes?: number | null;
  now?: number;
}

export interface KitchenPace {
  /** The band to display, bump included. */
  etaMin: number;
  etaMax: number;
  /** True while the bump is live, so surfaces can label it rather than hide it. */
  busy: boolean;
  /** Minutes actually added for the shop being busy. 0 when not busy. */
  addedMinutes: number;
  /** Minutes added for the weather in the shop's zone. */
  weatherMinutes: number;
}

/** Matches the 0036 CHECK. Clamped here too — the column is one defence, not the only one. */
const MAX_BUSY_EXTRA_MINUTES = 120;

/** What a shop that has advertised nothing at all is quoted as. */
const FALLBACK_ETA_MIN = 25;
const FALLBACK_ETA_MAX = 35;

export function kitchenPace(input: KitchenPaceInput): KitchenPace {
  const now = input.now ?? Date.now();

  const baseMin =
    typeof input.etaMin === "number" && input.etaMin > 0
      ? Math.round(input.etaMin)
      : FALLBACK_ETA_MIN;
  const rawMax =
    typeof input.etaMax === "number" && input.etaMax > 0
      ? Math.round(input.etaMax)
      : FALLBACK_ETA_MAX;
  // A band whose upper edge is below its lower one is a data-entry slip, not a
  // promise; widen rather than render "35–22 min".
  const baseMax = Math.max(baseMin, rawMax);

  const until = input.busyUntil ? Date.parse(input.busyUntil) : Number.NaN;
  const live = Number.isFinite(until) && until > now;
  const extra = live
    ? Math.min(
        MAX_BUSY_EXTRA_MINUTES,
        Math.max(0, Math.round(input.busyExtraMinutes ?? 0))
      )
    : 0;

  const weather = Math.min(60, Math.max(0, Math.round(input.weatherExtraMinutes ?? 0)));

  return {
    etaMin: baseMin + extra + weather,
    etaMax: baseMax + extra + weather,
    busy: extra > 0,
    addedMinutes: extra,
    weatherMinutes: weather,
  };
}
