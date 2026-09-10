import { haversineKm } from "@/lib/geo/distance";

/**
 * Is this address inside the shop's delivery area?
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
export type ServiceAreaStatus =
  /** Measured, and inside the radius. */
  | "in_range"
  /** Measured, and outside it. */
  | "out_of_range"
  /** No radius configured — nothing to check, so nothing to refuse. */
  | "unlimited"
  /** A radius IS set and a pin is missing, so the check cannot be made. */
  | "unverifiable";

/** Which end was missing. Only set when `status` is `unverifiable`. */
export type ServiceAreaGap = "shop_unpinned" | "address_unpinned";

export interface ServiceArea {
  status: ServiceAreaStatus;
  /** Straight-line km, or null when either end has no coordinates. */
  distanceKm: number | null;
  /** The configured radius, echoed so callers can write the message. */
  radiusKm: number;
  /** Why the answer is `unverifiable`; absent for every other status. */
  reason?: ServiceAreaGap;
}

export interface Point {
  lat?: number | null;
  lng?: number | null;
}

function coords(p: Point | null | undefined): { lat: number; lng: number } | null {
  if (!p) return null;
  if (typeof p.lat !== "number" || typeof p.lng !== "number") return null;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  return { lat: p.lat, lng: p.lng };
}

/**
 * The answer, and it fails CLOSED.
 *
 * What this used to do, and why it was wrong: every unanswerable case returned
 * `unknown`, and `createOrder` refused only `out_of_range` — so `unknown` was an
 * accept. On a database where 68 of 70 shops had never been pinned, that meant
 * 68 shops took orders from any distance on earth. One of them took a 70 km
 * order at the flat delivery fee and put a rider on it.
 *
 * The distinction that fixes it is between a DECISION and a FAILURE:
 *
 *   - radius 0 — the admin has not limited anything. There is no check to make,
 *     so there is nothing to fail, and a missing pin is irrelevant. `unlimited`.
 *   - radius set, a pin missing — there IS a check to make and we cannot make
 *     it. `unverifiable`, which `blocksOrder` refuses.
 *
 * The cost is deliberate and is the point: turning a radius on now takes every
 * unpinned shop offline until somebody pins it. That is the safe direction —
 * AGENTS.md rule 2, "a failed config check must reduce access, never widen it" —
 * and the shop comes back the moment its pin is set.
 */
export function checkServiceArea(input: {
  shop: Point | null | undefined;
  destination: Point | null | undefined;
  radiusKm: number;
}): ServiceArea {
  const radiusKm = Number.isFinite(input.radiusKm)
    ? Math.max(0, input.radiusKm)
    : 0;

  const from = coords(input.shop);
  const to = coords(input.destination);

  // Checked FIRST, and before the pins are looked at: with no radius there is
  // no question being asked, so an unpinned shop cannot fail to answer it.
  // Ordering this after the pin checks would refuse orders on a platform that
  // had deliberately switched the limit off, which is the opposite mistake.
  if (radiusKm <= 0) {
    return {
      status: "unlimited",
      distanceKm: from && to ? haversineKm(from, to) : null,
      radiusKm,
    };
  }

  // A radius is set, so the check is real. Either end missing means we cannot
  // perform it — and an unperformed check is a refusal, not a pass.
  if (!from || !to) {
    return {
      status: "unverifiable",
      distanceKm: null,
      radiusKm,
      reason: !from ? "shop_unpinned" : "address_unpinned",
    };
  }

  const distanceKm = haversineKm(from, to);
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
 * Why the order was refused, in a sentence a customer can act on.
 *
 * An unpinned SHOP is not the customer's fault and must not be described as if
 * it were: telling somebody their address is outside a delivery area, when the
 * truth is the restaurant never set its location, sends them off to re-pin an
 * address that was fine.
 */
export function outOfRangeMessage(area: ServiceArea): string {
  if (area.status === "unverifiable") {
    return area.reason === "shop_unpinned"
      ? "This shop hasn't set its location yet, so we can't confirm it delivers to you. Please try another shop while they finish setting up."
      : "We need your delivery location on the map before we can confirm this shop delivers to you. Please pick your address again.";
  }

  const distance =
    area.distanceKm === null ? null : Math.round(area.distanceKm * 10) / 10;
  return distance === null
    ? `This address is outside the ${area.radiusKm} km delivery area for this shop.`
    : `This address is about ${distance} km from the shop, outside its ${area.radiusKm} km delivery area.`;
}
