"use client";

import { useLocation } from "@/stores/location-store";
import { PINNED_LOCATION } from "@/lib/location/pinned";
import { distanceToShop, formatDistance } from "@/lib/geo/distance";
import { useT } from "@/components/providers/lang-provider";

/**
 * Only the pin. `distanceKm` used to be declared here too, described as the
 * fallback "for shops the vendor hasn't pinned yet" — but nothing in this file
 * ever read it, and the value behind it was manufactured (`?? 2` for every
 * unseeded shop). Requiring a pin is the honest contract: measure, or say
 * nothing.
 */
interface Shop {
  lat?: number | null;
  lng?: number | null;
}

/**
 * How far this shop is from the customer, measured live: the origin is the
 * location store, which starts at Bemetara and follows a detected fix or a
 * saved address. Client-side on purpose — the server has no idea where the
 * customer is standing, and the same shop is a different distance for everyone.
 *
 * A shop with no pin has no honest answer, so callers say what to do instead
 * via `fallback`.
 */
function useShopDistance(shop: Shop): string | null {
  const coords = useLocation((s) => s.coords);
  const km = distanceToShop(coords ?? PINNED_LOCATION.coords, shop);
  return km === null ? null : formatDistance(km);
}

/**
 * Inline "• 1.2 km" for a card's meta row. Renders nothing when unpinned.
 *
 * Marked "~" when the origin it is measured from is a restored fix past its
 * TTL. The cache used to carry no timestamp at all, so a distance computed from
 * a fix resolved in another city weeks ago was presented exactly like one
 * measured a second ago — and it also drives the sort order of the feed. The
 * tilde is the smallest honest signal that fits in a meta row; the header
 * carries the fuller version.
 */
export function ShopDistance({ shop }: { shop: Shop }) {
  const distance = useShopDistance(shop);
  const stale = useLocation((s) => s.status === "stale");
  const t = useT();
  if (!distance) return null;

  return (
    <>
      <span className="text-line">•</span>
      <span
        title={
          stale
            ? t(
                "Measured from your last known location",
                "आपकी पिछली पता चली लोकेशन से नापा गया",
              )
            : undefined
        }
      >
        {stale ? "~" : ""}
        {distance}
      </span>
    </>
  );
}

/**
 * Bare text for the restaurant page's info card.
 *
 * A shop the vendor has never pinned has no distance, and this used to fill the
 * slot with a literal "2 km" — the same 2 km for every unpinned shop, for every
 * customer, however far away they were. The label is simply empty instead.
 *
 * @public Parked: its call site in the restaurant page is commented out.
 */
export function ShopDistanceText({ shop }: { shop: Shop }) {
  const distance = useShopDistance(shop);
  return <>{distance ?? ""}</>;
}
