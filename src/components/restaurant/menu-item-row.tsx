"use client";

import { Plus, Minus } from "lucide-react";
import type { MenuItem, Restaurant } from "@/types";
import { useCart } from "@/stores/cart-store";
import { useCartSwitch } from "@/stores/cart-switch-store";
import { useItemSheet } from "@/stores/item-sheet-store";
import { VegMark } from "@/components/shared/veg-mark";
import { PhotoTile } from "@/components/shared/photo-tile";
import { ItemPrice } from "@/components/shared/item-price";
import { cn } from "@/lib/utils/cn";
import { useT } from "@/components/providers/lang-provider";

export function MenuItemRow({
  item,
  restaurant,
}: Readonly<{
  item: MenuItem;
  restaurant: Restaurant;
}>) {
  const lines = useCart((s) => s.lines);
  const cartSlug = useCart((s) => s.restaurantSlug);
  const setQty = useCart((s) => s.setQty);
  const request = useCartSwitch((s) => s.request);
  const openSheet = useItemSheet((s) => s.open);
  const t = useT();

  // Menu item ids are unique within a menu, not across the catalog — so the
  // quantity only counts when the basket belongs to this restaurant.
  const qty =
    cartSlug === restaurant.slug
      ? (lines.find((l) => l.itemId === item.id)?.qty ?? 0)
      : 0;
  const ref = { slug: restaurant.slug, name: restaurant.name };

  const handleAdd = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    request(item, ref);
  };

  return (
    <div
      className={cn(
        "relative flex gap-3.5 py-3.5 pb-5",
        (item.soldOut || !restaurant.open) && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => openSheet(item, restaurant)}
        className="min-w-0 flex-1 text-left"
      >
        {item.bestseller || item.popular ? (
          <span className="pill-pop mb-1.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
            {t("Popular", "लोकप्रिय")}
          </span>
        ) : null}
        <div className="flex items-center gap-1.5">
          <VegMark veg={item.veg} />
          <h3 className="text-[15px] font-bold leading-tight">{item.name}</h3>
        </div>
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted">
          {item.description}
        </p>
        <p className="mt-1.5 text-[14px] font-extrabold tracking-tight">
          <ItemPrice item={item} />
        </p>
      </button>

      <div className="relative z-20 size-24 shrink-0">
        <PhotoTile
          tint={restaurant.accentTint}
          src={item.image}
          alt={item.name}
          className="size-24 rounded-lg"
          sizes="96px"
        />

        {/* A shut kitchen is stated as such rather than offering an Add that
            would build a basket nobody can cook — same rule as the search
            dish card. The menu itself stays visible so people can browse. */}
        {!restaurant.open ? (
          <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-black/65 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-white">
            {t("Closed", "बंद")}
          </span>
        ) : item.soldOut ? (
          <span className="absolute inset-x-0 bottom-0 rounded-b-xl bg-ink/70 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-white">
            {t("Sold out", "ख़त्म हो गया")}
          </span>
        ) : qty === 0 ? (
          <button
            type="button"
            onClick={handleAdd}
            aria-label={t(`Add ${item.name}`, `${item.name} जोड़ें`)}
            className="tap-target press bolt-add"
          >
            {t("Add", "जोड़ें")}
          </button>
        ) : (
          <div className="bolt-add-qty">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setQty(item.id, qty - 1);
              }}
              aria-label={t("Remove one", "एक कम करें")}
              className="tap-target grid size-7 place-items-center rounded-md hover:bg-white/15"
            >
              <Minus className="size-4" strokeWidth={2.75} />
            </button>
            <span className="min-w-4 text-center text-data text-sm font-bold tabular-nums">
              {qty}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setQty(item.id, qty + 1);
              }}
              aria-label={t("Add one", "एक और जोड़ें")}
              className="tap-target grid size-7 place-items-center rounded-md hover:bg-white/15"
            >
              <Plus className="size-4" strokeWidth={2.75} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
