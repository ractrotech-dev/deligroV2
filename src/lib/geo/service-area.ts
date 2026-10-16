import { HINDI_ENABLED, translator, type Lang, type T } from "@/lib/i18n/lang";
import { haversineKm } from "@/lib/geo/distance";
import { PINNED_LOCATION } from "@/lib/location/pinned";

/**
 * Is this address inside Deligro's delivery area — one circle around
 * Bemetara (see SERVICE_CENTRE)?
 *
 * One rule, shared by the checkout warning and the order API that refuses, so
 * the sentence a customer reads before they commit and the decision made after
 * they tap cannot disagree.
 *
 * `platform_settings.delivery_radius_km` has been admin-configurable and
 * persisted since migration 0015 and was read by nothing at all: orders were
 * accepted from any address at any distance, at the flat delivery fee, and a
 * rider was dispatched on a trip whose economics had never been checked.
 *
 * Straight-line, not road distance — see `haversineKm`. That makes it
 * permissive at the boundary (the road is always at least as long as the crow
 * flies), which is the right direction for a gate that can refuse someone's
 * dinner: it only ever rejects addresses that are out of range by any measure.
 */

/**
 * Four answers, because there are four genuinely different situations and the
 * old three collapsed two of them into one.
 *
 * `unlimited` and `unverifiable` were both `unknown`, which is why the gate
 * leaked: one is an administrator deciding not to limit anything, the other is
 * this module admitting it cannot answer. Treating them alike meant every
 * unpinned shop was waved through as though the radius had been switched off
 * on purpose.
 */
type ServiceAreaStatus =
  /** Measured, and inside the radius. */
  | "in_range"
  /** Measured, and outside it. */
  | "out_of_range"
  /** No radius configured — nothing to check, so nothing to refuse. */
  | "unlimited"
  /** The delivery address has no pin, so the check cannot be made. */
  | "unverifiable";

/**
 * Why an order was refused, when it isn't simply "the address is too far".
 *
 * `address_unpinned` — the delivery address has no map pin (`unverifiable`).
 * `shop_outside_area` — the shop itself is pinned outside the city circle
 *   (`out_of_range`); a customer in town can't order from it.
 */
type ServiceAreaGap = "address_unpinned" | "shop_outside_area";

export interface ServiceArea {
  status: ServiceAreaStatus;
  /** Straight-line km from the city centre, or null when the address has no pin. */
  distanceKm: number | null;
  /** The configured radius, echoed so callers can write the message. */
  radiusKm: number;
  /** Set when the refusal is not the plain "address too far" case. */
  reason?: ServiceAreaGap;
}

export interface Point {
  lat?: number | null;
  lng?: number | null;
}

/**
 * The centre of the delivery area: Bemetara.
 *
 * Deligro launches as a one-city app (decided 28 Sept 2026): a single circle of
 * `delivery_radius_km` around the city centre, not a circle around each shop.
 * Going multi-city means replacing this with the customer's city — the same
 * seam as PINNED_LOCATION, which it reads.
 */
const SERVICE_CENTRE = PINNED_LOCATION.coords;

function coords(p: Point | null | undefined): { lat: number; lng: number } | null {
  if (!p) return null;
  if (typeof p.lat !== "number" || typeof p.lng !== "number") return null;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  return { lat: p.lat, lng: p.lng };
}

/**
 * The answer. Measured from the CITY CENTRE, and it still fails closed.
 *
 * It used to measure from the shop and refuse every order from an unpinned
 * shop once a radius was set — correct for a per-shop radius (a Durg shop took
 * a 70 km order that way), and the reason most shops could not take orders at
 * all while 68 of 70 were unpinned. With one city circle the question is
 * "is this address in Bemetara's delivery area?", which needs no shop pin.
 *
 * What still refuses:
 *   - an address with no pin, at any radius (`unverifiable`, `address_unpinned`):
 *     nobody can deliver to it;
 *   - an address outside the circle (`out_of_range`);
 *   - a shop that IS pinned outside the circle (`out_of_range`,
 *     `shop_outside_area`) — the one piece of the old per-shop rule worth
 *     keeping, so a shop onboarded outside the city cannot take town orders.
 *
 * An unpinned shop is taken to be in town: shops are onboarded by hand, in
 * Bemetara. Radius 0 is still the admin switching the limit off (`unlimited`).
 */
export function checkServiceArea(input: {
  /** Checked only when pinned — see above. */
  shop?: Point | null;
  destination: Point | null | undefined;
  radiusKm: number;
  /** Defaults to Bemetara. */
  centre?: Point;
}): ServiceArea {
  const radiusKm = Number.isFinite(input.radiusKm)
    ? Math.max(0, input.radiusKm)
    : 0;
  const centre = coords(input.centre) ?? SERVICE_CENTRE;
  const to = coords(input.destination);

  // The delivery address must always be on the map, whatever the radius — a
  // pinless saved "Bhilai" was once orderable from a Bemetara shop.
  if (!to) {
    return {
      status: "unverifiable",
      distanceKm: null,
      radiusKm,
      reason: "address_unpinned",
    };
  }

  const distanceKm = haversineKm(centre, to);

  // No radius: the admin has decided not to limit anything.
  if (radiusKm <= 0) {
    return { status: "unlimited", distanceKm, radiusKm };
  }

  const shop = coords(input.shop);
  if (shop && haversineKm(centre, shop) > radiusKm) {
    return { status: "out_of_range", distanceKm, radiusKm, reason: "shop_outside_area" };
  }

  return {
    status: distanceKm > radiusKm ? "out_of_range" : "in_range",
    distanceKm,
    radiusKm,
  };
}

/**
 * Does this answer stop the order?
 *
 * One predicate, because the checkout that greys out the button and the order
 * API that refuses must never disagree — they were two separate
 * `status === "out_of_range"` comparisons, which is the same rule written
 * twice and the shape a leak grows back in. A new status is refused here by
 * default: anything that is not positively "we checked, it is fine" blocks.
 */
export function blocksOrder(area: ServiceArea): boolean {
  return area.status !== "in_range" && area.status !== "unlimited";
}

/**
 * Why the order was refused, in a sentence a customer can act on. Pass the
 * customer's language; without one it says it in both (English / Hindi), for
 * callers that cannot know who will read it.
 */
export function outOfRangeMessage(area: ServiceArea, lang?: Lang): string {
  const en = outOfRangeText(area, translator("en"));
  const hi = outOfRangeText(area, translator("hi"));
  if (!HINDI_ENABLED) return en;
  return lang === "en" ? en : lang === "hi" ? hi : `${en} / ${hi}`;
}

function outOfRangeText(area: ServiceArea, t: T): string {
  if (area.status === "unverifiable") {
    return t(
      'Put your delivery address on the map first (drop a pin or tap "Use my location"), so we can check we deliver there.',
      "पहले नक्शे पर अपना पता लगाएं (पिन लगाएं या \"मेरी लोकेशन\" दबाएं), ताकि हम देख सकें कि वहां डिलीवरी होती है।"
    );
  }
  if (area.reason === "shop_outside_area") {
    return t(
      `This shop is outside our ${area.radiusKm} km Bemetara delivery area, so it can't deliver to you. Please pick another shop.`,
      `यह दुकान हमारे ${area.radiusKm} किमी बेमेतरा डिलीवरी क्षेत्र से बाहर है, इसलिए आप तक डिलीवरी नहीं कर सकती। कृपया दूसरी दुकान चुनें।`
    );
  }
  const distance =
    area.distanceKm === null ? null : Math.round(area.distanceKm * 10) / 10;
  return distance === null
    ? t(
        `Sorry, we deliver only within ${area.radiusKm} km of Bemetara.`,
        `माफ़ करें, हम केवल बेमेतरा के ${area.radiusKm} किमी के अंदर डिलीवरी करते हैं।`
      )
    : t(
        `Sorry, we deliver only within ${area.radiusKm} km of Bemetara — this address is about ${distance} km away.`,
        `माफ़ करें, हम केवल बेमेतरा के ${area.radiusKm} किमी के अंदर डिलीवरी करते हैं — यह पता लगभग ${distance} किमी दूर है।`
      );
}
