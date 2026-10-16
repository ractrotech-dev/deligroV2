"use client";

import Link from "next/link";
import { Clock, Bike } from "lucide-react";
// BadgePercent — used by the temporarily hidden offer banner below
import type { Restaurant } from "@/types";
import { PhotoTile } from "@/components/shared/photo-tile";
// RatingPill — used by the temporarily hidden rating star below
// import { RatingPill } from "@/components/shared/rating";
import { ShopDistance } from "@/components/shared/shop-distance";
import { formatEta, formatINR } from "@/lib/utils/format";
import { useChargesConfig } from "@/components/providers/charges-config-provider";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

/**
 * Bolt-style discovery card.
 * - "list"     → full-width row in a vertical feed
 * - "carousel" → fixed-width tile inside a horizontal scroller
 * Sold-out / closed venues are dimmed, not hidden.
 *
 * A client component for the delivery fee alone: the card advertises a price,
 * so it has to read the live one from the customer layout's settings context
 * rather than a build-time constant. (Its meta row already rendered a client
 * child — ShopDistance — so this costs no extra boundary.)
 */
export function RestaurantCard({
  restaurant,
  variant = "list",
}: Readonly<{
  restaurant: Restaurant;
  variant?: "list" | "carousel";
}>) {
  const r = restaurant;
  const carousel = variant === "carousel";
  const { deliveryFee } = useChargesConfig();
  const t = useT();

  return (
    <Link
      href={`/restaurant/${r.slug}`}
      className={cn(
        "press block",
        carousel ? "w-[240px] shrink-0" : "w-full",
        !r.open && "opacity-60",
      )}
    >
      <div className="relative overflow-hidden rounded-2xl">
        <PhotoTile
          tint={r.accentTint}
          src={r.image}
          alt={r.name}
          className={carousel ? "h-32 w-full" : "h-40 w-full"}
          sizes={carousel ? "240px" : "(max-width: 480px) 100vw, 400px"}
        />
        {/* Temporarily hidden — offer banner not needed right now
        {r.offer ? (
          <span className="pill-deal absolute left-2.5 top-2.5 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-bold uppercase tracking-wide">
            <BadgePercent className="size-3.5" />
            {r.offer}
          </span>
        ) : null}
        */}
        {/* The decorative heart that used to sit here was a lie in both
            directions: it never showed whether a place WAS a favourite, and
            tapping it never made one. The working control is on the restaurant
            page (RestaurantActions). */}
        {/* "Opens soon" implied a schedule. There isn't one — `is_open` is a
            switch a vendor flips, and nothing in the platform knows when (or
            whether) it will flip back. "Closed" says the part we can stand
            behind. */}
        {!r.open ? (
          <span className="absolute bottom-2.5 right-2.5 rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-white">
            {t("Closed", "बंद")}
          </span>
        ) : null}
        {/* Temporarily hidden — rating star not needed right now
        {r.open ? (
          <RatingPill
            variant="chip"
            rating={r.rating}
            count={r.ratingCount}
            className="absolute bottom-2.5 left-2.5"
          />
        ) : null}
        */}
      </div>

      <div className="px-0.5 pt-2">
        <h3 className="truncate text-[15px] font-extrabold leading-tight tracking-tight">
          {r.name}
        </h3>
        <p className="mt-0.5 truncate text-[12px] text-muted">
          {r.cuisines.join(" · ")}
        </p>
        <div className="mt-1.5 flex items-center gap-2 text-[12px] font-medium text-muted">
          <span className="inline-flex items-center gap-1">
            <Bike className="size-4" />
            {/* The fee we actually bill, from the live platform settings.
                Two earlier versions of this line advertised a number checkout
                then disagreed with: `priceTier * 20` (priceTier is the ₹/₹₹/₹₹₹
                cost-for-two indicator, never a fee), and then the pricing.ts
                default — right until the first time an admin changed it. */}
            {deliveryFee === 0 ? t("Free", "फ़्री") : formatINR(deliveryFee)}
          </span>
          <span className="text-line">•</span>
          {/* Already includes any live busy bump (see mapRestaurant). Labelled
              when it does: a band that silently grew reads as a slow shop, where
              "Busy" reads as a kitchen being straight with you. */}
          <span
            className={cn(
              "inline-flex items-center gap-1",
              r.busy && "font-semibold text-deal",
            )}
          >
            <Clock className="size-4" />
            {formatEta(r.etaMin, r.etaMax)}
            {r.busy ? t(" · Busy", " · व्यस्त") : ""}
          </span>
          <ShopDistance shop={r} />
        </div>
      </div>
    </Link>
  );
}
