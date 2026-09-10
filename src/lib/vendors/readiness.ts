/**
 * Is this shop ready to be live?
 *
 * Today that asks one question — has somebody put it on the map — because a
 * shop without a pin quietly breaks three separate things, all of which were
 * live on this platform at once:
 *
 *   - `lib/geo/service-area.ts` cannot check the delivery radius, so before it
 *     was made to fail closed the shop accepted orders from any distance. One
 *     took a 70 km order at the flat delivery fee and dispatched a rider.
 *   - `lib/orders/eta.ts` has no distance to model, so the estimate falls back
 *     to the kitchen's advertised band — a 70 km trip shown as "25 min".
 *   - `lib/tracking/rider-position.ts` has no origin, so the customer's map
 *     used to draw a route out of a coordinate hashed from the shop's UUID.
 *
 * Each of those now degrades honestly on its own. This module is the other
 * half: it stops new unpinned shops reaching the state where any of it matters.
 *
 * Pure and dependency-free so both the admin data-access layer and any test can
 * use it without a database.
 */

/** The two columns that make a shop locatable. Both, or neither. */
export interface VendorPin {
  lat?: number | null;
  lng?: number | null;
}

/**
 * A shop that cannot go live yet, and why — typed so callers can tell it from a
 * database failure and show the operator something they can act on.
 */
export class VendorNotPinnedError extends Error {
  constructor(readonly vendorName: string) {
    super(
      `${vendorName} has no location on the map. Set the shop's pin before making it live — ` +
        `without one we cannot check its delivery radius, estimate a delivery time, or show it on a customer's map.`
    );
    this.name = "VendorNotPinnedError";
  }
}

/**
 * Does this row carry a real coordinate pair?
 *
 * Explicitly `typeof === "number"` and `Number.isFinite`, never a truthiness
 * test. `lat: 0` is the equator and `lng: 0` is the Greenwich meridian — both
 * are ordinary coordinates, and a falsy check would refuse to activate a shop
 * that had been placed perfectly well. Postgres `numeric` columns can also
 * arrive over PostgREST as strings, and `"21.7"` is not a number however much
 * it looks like one.
 */
export function isPinned(pin: VendorPin): boolean {
  return (
    typeof pin.lat === "number" &&
    typeof pin.lng === "number" &&
    Number.isFinite(pin.lat) &&
    Number.isFinite(pin.lng)
  );
}

/**
 * Throw unless this shop may be made live.
 *
 * Called on the TRANSITION into active, never on rows that are already there:
 * 49 shops on this database are active and unpinned, and re-validating them on
 * every write would leave an operator unable to close one for the evening. They
 * are already prevented from taking orders by the service-area gate; this stops
 * the set growing.
 */
export function assertCanGoLive(pin: VendorPin, vendorName: string): void {
  if (!isPinned(pin)) throw new VendorNotPinnedError(vendorName);
}
