/**
 * An offer's window — the rules, with no database and no clock of their own.
 *
 * Pure on purpose (no `server-only`, no imports): `scripts/qa/rider-offers.ts`
 * runs it under tsx. It is the ONE definition of "whose offer is this right
 * now": the job board, `acceptDelivery`, the commitment check that stops a
 * rider going offline with an offer pending and dispatch's ring all ask
 * `offerState`, so a board can never show a card the server then refuses.
 *
 * The window itself is `platform_settings.rider_offer_window_seconds` (0082,
 * 60-600 s). `EXCLUSIVE_OFFER_MS` in `rider-dispatch.ts` survives only as the
 * fallback for a database without that column.
 */

export const OFFER_WINDOW_DEFAULT_SECONDS = 180;
export const OFFER_WINDOW_MIN_SECONDS = 60;
export const OFFER_WINDOW_MAX_SECONDS = 600;

/**
 * The window to apply, from whatever the settings read produced. The database
 * constrains the column to 60-600, but a stored value is not trusted blindly: a
 * missing or garbled one reads as the default, and an out-of-range one is
 * clamped, so a bad setting can neither strand an order (a huge window) nor
 * make every offer lapse before it is seen (a tiny one).
 */
export function normalizeOfferWindow(seconds: unknown): number {
  const n =
    typeof seconds === "number"
      ? seconds
      : typeof seconds === "string" && seconds.trim() !== ""
        ? Number(seconds)
        : Number.NaN;
  if (!Number.isFinite(n)) return OFFER_WINDOW_DEFAULT_SECONDS;
  return Math.min(Math.max(Math.round(n), OFFER_WINDOW_MIN_SECONDS), OFFER_WINDOW_MAX_SECONDS);
}

function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** When the offer stops being exclusive (ISO), or null when it has no timestamp to count from. */
export function offerDeadline(offeredAt: string | null, windowSeconds: number): string | null {
  const at = instant(offeredAt);
  return at === null ? null : new Date(at + windowSeconds * 1000).toISOString();
}

/**
 * Where one rider stands in relation to one offer.
 *
 *   "mine" - held for them, and only them, for the rest of the window.
 *   "held" - held for somebody else. The board hides it and accept refuses it.
 *   "open" - no live offer. First to accept takes it.
 *
 * An offer with no timestamp has no window to be inside, so it reads as open.
 * Failing the other way would strand an order on a data glitch. The deadline
 * itself is already open: the rider's window is the half-open interval
 * [offeredAt, offeredAt + window).
 */
export type OfferState = "open" | "mine" | "held";

export function offerState(
  driverId: string,
  offer: { offeredDriverId: string | null; offeredAt: string | null } | null | undefined,
  windowSeconds: number,
  now: Date
): OfferState {
  if (!offer?.offeredDriverId) return "open";
  const at = instant(offer.offeredAt);
  if (at === null || now.getTime() - at >= windowSeconds * 1000) return "open";
  return offer.offeredDriverId === driverId ? "mine" : "held";
}

/** Why a rider turned an offer down. The app shows these; the server stores the code. */
export const REJECT_REASONS = [
  "too_far",
  "vehicle_issue",
  "on_break",
  "low_battery",
  "other",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === "string" && (REJECT_REASONS as readonly string[]).includes(value);
}

/**
 * Road km when routing is unavailable: straight line x 1.3, two decimals.
 * (Roads are longer than the crow flies; 1.3 is the planning figure the rider
 * app's design names for the fallback, a little longer than the ETA model's
 * 1.25 because it is a distance that earns money, not a time that promises one.)
 */
export function roadKmFallback(straightKm: number): number {
  return Math.round(straightKm * 1.3 * 100) / 100;
}
