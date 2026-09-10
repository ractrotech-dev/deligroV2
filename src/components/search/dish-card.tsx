"use client";

import Link from "next/link";
import { Clock, Minus, Plus, Star } from "lucide-react";
import type { DishHit } from "@/lib/search/dishes";
import { useCart } from "@/stores/cart-store";
import { useCartSwitch } from "@/stores/cart-switch-store";
import { useItemSheet } from "@/stores/item-sheet-store";
import { VegMark } from "@/components/shared/veg-mark";
import { PhotoTile } from "@/components/shared/photo-tile";
import { ShopDistance } from "@/components/shared/shop-distance";
import { ItemPrice } from "@/components/shared/item-price";
import { formatEta, formatRating } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * A search result that is a *dish*, not a restaurant.
 *
 * Same shape as a menu row — photo right, ADD pill overhanging it — plus the one
 * thing a menu row never needs: which kitchen it comes from, and a way through
 * to that kitchen's full menu. Tapping the dish opens the item sheet, tapping
 * the shop line goes to the restaurant.
 */
export function DishCard({ hit }: { hit: DishHit }) {
  const { item, restaurant } = hit;

  const lines = useCart((s) => s.lines);
  const cartSlug = useCart((s) => s.restaurantSlug);
  const setQty = useCart((s) => s.setQty);
  const request = useCartSwitch((s) => s.request);
  const openSheet = useItemSheet((s) => s.open);

  // Only count the line when the basket is actually this restaurant's: menu item
  // ids are unique within a menu, not across the catalog, so two shops can share
  // one id and the other shop's quantity would otherwise show up here.
  const qty =
    cartSlug === restaurant.slug
      ? lines.find((l) => l.itemId === item.id)?.qty ?? 0
      : 0;

  const unavailable = item.soldOut || !restaurant.open;

  return (
    <div className={cn("relative flex gap-3.5 py-3.5 pb-5", unavailable && "opacity-60")}>
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <button
          type="button"
          onClick={() => openSheet(item, restaurant)}
          className="min-w-0 text-left"
        >
          {item.popular || item.bestseller ? (
            <span className="pill-pop mb-1.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
              Popular
            </span>
          ) : null}
          <div className="flex items-center gap-1.5">
            <VegMark veg={item.veg} />
            <h3 className="text-[15px] font-bold leading-tight">{item.name}</h3>
          </div>
          <p className="mt-1.5 text-[14px] font-extrabold tracking-tight">
            <ItemPrice item={item} />
          </p>
        </button>

        <Link
          href={`/restaurant/${restaurant.slug}`}
          className="press mt-1.5 min-w-0 max-w-full"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-ink">
            <span className="truncate">{restaurant.name}</span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-muted">
              <Star className="size-3 fill-pop text-pop" />
              {formatRating(restaurant.rating)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[12px] font-medium text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {formatEta(restaurant.etaMin, restaurant.etaMax)}
            </span>
            <ShopDistance shop={restaurant} />
          </span>
        </Link>
      </div>

      {/* `z-20` is not decoration: it opens a stacking context so the ADD pill's
          `z-index: 30` resolves INSIDE this 96px box instead of competing with
          the whole page. Without it the pill out-ranked the sticky search header
          and painted over the search field as the list scrolled under it.
          `menu-item-row.tsx` carries the same pair for the same reason. */}
      <div className="relative z-20 size-24 shrink-0 self-start">
        <PhotoTile
          tint={restaurant.accentTint}
          src={item.image}
          alt={item.name}
          className="size-24 rounded-lg"
          sizes="96px"
        />

        {/* A shut kitchen is stated as such rather than offering an Add that
            would build a basket nobody can cook. */}
        {!restaurant.open ? (
          <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-ink/70 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-white">
            Closed
          </span>
        ) : item.soldOut ? (
          <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-ink/70 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-white">
            Sold out
          </span>
        ) : qty === 0 ? (
          <button
            type="button"
            onClick={() =>
              request(item, { slug: restaurant.slug, name: restaurant.name })
            }
            aria-label={`Add ${item.name} from ${restaurant.name}`}
            className="press bolt-add"
          >
            Add
          </button>
        ) : (
          <div className="bolt-add-qty">
            <button
              type="button"
              onClick={() => setQty(item.id, qty - 1)}
              aria-label="Remove one"
              className="grid size-7 place-items-center rounded-md hover:bg-white/15"
            >
              <Minus className="size-4" strokeWidth={2.75} />
            </button>
            <span className="min-w-4 text-center text-data text-sm font-bold tabular-nums">
              {qty}
            </span>
            <button
              type="button"
              onClick={() => setQty(item.id, qty + 1)}
              aria-label="Add one"
              className="grid size-7 place-items-center rounded-md hover:bg-white/15"
            >
              <Plus className="size-4" strokeWidth={2.75} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
