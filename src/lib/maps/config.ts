import { PINNED_LOCATION } from "@/lib/location/pinned";

/**
 * Google Maps config. The browser key is public by design (restrict it by HTTP
 * referrer in the Google Cloud console). When it's absent the map picker falls
 * back to a plain text address field, so the checkout still works.
 */
export const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

export const isMapsConfigured = GOOGLE_MAPS_API_KEY.length > 0;

/**
 * Default map centre, used before we have a fix. Same place the app assumes the
 * customer is (see lib/location/pinned) — one city, one constant.
 */
export const DEFAULT_CENTER = PINNED_LOCATION.coords;

