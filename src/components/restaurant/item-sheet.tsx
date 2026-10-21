"use client";

import { useEffect, useRef, useState } from "react";
import { X, Plus, Minus } from "lucide-react";
import { useCart } from "@/stores/cart-store";
import { useCartSwitch } from "@/stores/cart-switch-store";
import { useItemSheet } from "@/stores/item-sheet-store";
import { PhotoTile } from "@/components/shared/photo-tile";
import { VegMark } from "@/components/shared/veg-mark";
import { ItemPrice } from "@/components/shared/item-price";
import { useT } from "@/components/providers/lang-provider";
import { formatINR } from "@/lib/utils/format";
import {
  choicePrice,
  choiceProblem,
  clockLabel,
  hasOptions,
  offeredNow,
  type OptionChoice,
} from "@/lib/orders/order-options";
import type { MenuAddonGroup, MenuItem } from "@/types";

/**
 * Bolt-style product detail popup. Mounted once at app-shell level so it
 * overlays the whole frame; opened via the item-sheet store from a menu row.
 * A dish with sizes or add-ons (0062) is chosen here: the same rules the
 * order-line guard enforces decide whether Add is enabled.
 */
export function ItemSheet() {
  const item = useItemSheet((s) => s.item);
  const restaurant = useItemSheet((s) => s.restaurant);

  if (!item || !restaurant) return null;
  return <ItemSheetInner key={item.id} />;
}

function ItemSheetInner() {
  const item = useItemSheet((s) => s.item)!;
  const restaurant = useItemSheet((s) => s.restaurant)!;
  const onClose = useItemSheet((s) => s.close);
  const t = useT();

  const request = useCartSwitch((s) => s.request);
  const lines = useCart((s) => s.lines);
  const cartSlug = useCart((s) => s.restaurantSlug);
  // Only this restaurant's basket can pre-fill the stepper — ids repeat across
  // menus, so another shop's quantity is not this dish's quantity.
  // A dish with options adds a new line per choice, so there is no single
  // basket quantity to pre-fill.
  const withOptions = hasOptions(item);
  const inCart =
    cartSlug === restaurant.slug && !withOptions
      ? (lines.find((l) => l.itemId === item.id && !l.key)?.qty ?? 0)
      : 0;

  const [qty, setQty] = useState(Math.max(inCart, 1));
  const [choice, setChoice] = useState<OptionChoice>(() => ({
    // The first size on offer is picked to start with, as menus print it.
    variantId: item.variants?.find((v) => v.available)?.id ?? null,
    addonIds: [],
  }));

  const ref = { slug: restaurant.slug, name: restaurant.name };
  const offered = offeredNow(item);
  const problem = choiceProblem(item, choice);
  const overStock = item.stockLeft != null && qty > item.stockLeft;
  const canAdd = restaurant.open && !item.soldOut && offered && !problem && !overStock;

  let commitLabel: string;
  if (!restaurant.open) commitLabel = t("Closed", "बंद");
  else if (item.soldOut) commitLabel = t("Sold out", "ख़त्म हो गया");
  else if (!offered) commitLabel = t("Not available now", "अभी उपलब्ध नहीं");
  else commitLabel = t("Add", "जोड़ें");

  const commit = () => {
    // Adds at the chosen quantity, or asks first when this would replace a
    // basket from another kitchen (see cart-switch-store).
    request(item, ref, qty, choice);
    onClose();
  };

  // A dialog, announced as one: it was a plain div, so a screen reader landed
  // on nothing it could name, and Escape (a hardware keyboard, a TalkBack
  // back gesture mapped to it) did nothing. Focus moves into the sheet when it
  // opens so the next swipe reads the dish, not the menu behind it.
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50">
      <button
        aria-label={t("Close", "बंद करें")}
        onClick={onClose}
        className="animate-fade-in absolute inset-0 bg-ink/40"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
        tabIndex={-1}
        className="animate-sheet-in bolt-sheet absolute inset-x-0 bottom-0 max-h-[92%] overflow-hidden outline-none"
      >
        <div className="bolt-sheet-handle" />
        <div className="no-scrollbar max-h-[92vh] overflow-y-auto">
          {/* Hero image with close */}
          <div className="relative">
            <PhotoTile
              tint={restaurant.accentTint}
              src={item.image}
              alt={item.name}
              className="h-56 w-full"
              sizes="100vw"
            />
            <button
              onClick={onClose}
              aria-label={t("Close", "बंद करें")}
              className="press absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-surface text-ink shadow-[var(--shadow-md)]"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="px-5 pb-5 pt-4">
            {item.bestseller || item.popular ? (
              <span className="pill-pop mb-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
                {t("Popular", "लोकप्रिय")}
              </span>
            ) : null}

            <div className="flex items-center gap-2">
              <VegMark veg={item.veg} />
              <h2 className="text-[22px] font-extrabold leading-tight tracking-tight">
                {item.name}
              </h2>
            </div>
            <p className="mt-1 text-[17px] font-extrabold tracking-tight">
              <ItemPrice item={item} fromLabel={t("from", "से शुरू")} />
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {item.description}
            </p>
            <Availability item={item} offered={offered} />
          </div>

          {withOptions ? (
            <OptionsPicker item={item} choice={choice} onChange={setChoice} />
          ) : null}
        </div>

        {/* Footer: quantity + add */}
        <div className="flex items-center gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="flex h-12 shrink-0 items-center gap-1 rounded-full border border-line px-1">
            <button
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              aria-label={t("Remove one", "एक कम करें")}
              className="tap-target press grid size-11 place-items-center rounded-full text-ink hover:bg-surface-2"
            >
              <Minus className="size-5" strokeWidth={2.5} />
            </button>
            <span className="min-w-8 text-center text-data text-lg font-bold tabular-nums">
              {qty}
            </span>
            <button
              onClick={() => setQty((q) => Math.min(item.stockLeft ?? 50, q + 1, 50))}
              aria-label={t("Add one", "एक और जोड़ें")}
              className="tap-target press grid size-11 place-items-center rounded-full text-ink hover:bg-surface-2"
            >
              <Plus className="size-5" strokeWidth={2.5} />
            </button>
          </div>

          <button
            onClick={commit}
            disabled={!canAdd}
            className="press flex h-12 flex-1 items-center justify-between rounded-full bg-accent px-5 text-[16px] font-bold text-[var(--on-accent)] shadow-[var(--glow-accent)] disabled:opacity-50"
          >
            <span>
              {commitLabel}
            </span>
            {!item.soldOut && restaurant.open && offered ? (
              <span>
                {withOptions ? formatINR(choicePrice(item, choice) * qty) : <ItemPrice item={item} qty={qty} />}
              </span>
            ) : null}
          </button>
        </div>
      </div>
    </div>
  );
}

/** When the dish is offered, and how many are left, when that matters. */
function Availability({ item, offered }: Readonly<{ item: MenuItem; offered: boolean }>) {
  const t = useT();
  const from = clockLabel(item.availableFrom);
  const to = clockLabel(item.availableTo);
  const days = item.availableDays;
  const dayNames = [
    t("Sun", "रवि"),
    t("Mon", "सोम"),
    t("Tue", "मंगल"),
    t("Wed", "बुध"),
    t("Thu", "गुरु"),
    t("Fri", "शुक्र"),
    t("Sat", "शनि"),
  ];
  const notes: string[] = [];
  if (from && to) notes.push(t(`Available ${from} – ${to}`, `${from} – ${to} उपलब्ध`));
  if (days && days.length > 0 && days.length < 7) notes.push(days.map((d) => dayNames[d]).join(", "));
  const low = item.stockLeft != null && item.stockLeft > 0 && item.stockLeft <= 5;
  if (notes.length === 0 && !low) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-[13px] font-semibold">
      {notes.length > 0 ? (
        <span className={`rounded-md px-2 py-1 ${offered ? "bg-surface-2 text-ink" : "pill-deal"}`}>
          {offered ? notes.join(" · ") : `${t("Not available now", "अभी उपलब्ध नहीं")} · ${notes.join(" · ")}`}
        </span>
      ) : null}
      {low ? (
        <span className="pill-deal rounded-md px-2 py-1">
          {t(`Only ${item.stockLeft} left`, `सिर्फ़ ${item.stockLeft} बचे`)}
        </span>
      ) : null}
    </div>
  );
}

/** Sizes as a radio list; each add-on group as checkboxes within its min/max. */
function OptionsPicker({
  item,
  choice,
  onChange,
}: Readonly<{ item: MenuItem; choice: OptionChoice; onChange: (c: OptionChoice) => void }>) {
  const t = useT();
  const sizes = item.variants ?? [];

  const toggleAddon = (group: MenuAddonGroup, id: string) => {
    const inGroup = new Set(group.addons.map((a) => a.id));
    const picked = choice.addonIds.filter((a) => inGroup.has(a));
    let next = choice.addonIds;
    if (picked.includes(id)) next = next.filter((a) => a !== id);
    else if (group.maxSelect === 1) next = [...next.filter((a) => !inGroup.has(a)), id];
    else if (picked.length < group.maxSelect) next = [...next, id];
    onChange({ ...choice, addonIds: next });
  };

  const rule = (g: MenuAddonGroup) => {
    if (g.minSelect === 0) return t(`Optional · up to ${g.maxSelect}`, `वैकल्पिक · ${g.maxSelect} तक`);
    if (g.minSelect === g.maxSelect) return t(`Required · pick ${g.minSelect}`, `ज़रूरी · ${g.minSelect} चुनें`);
    return t(`Required · pick ${g.minSelect}–${g.maxSelect}`, `ज़रूरी · ${g.minSelect}–${g.maxSelect} चुनें`);
  };

  const row = "flex min-h-12 w-full items-center gap-3 px-5 py-2 text-left disabled:opacity-45";
  const mark = (on: boolean, round: boolean) =>
    `grid size-5 shrink-0 place-items-center border-2 ${round ? "rounded-full" : "rounded-md"} ${
      on ? "border-accent bg-accent" : "border-line"
    }`;

  return (
    <div className="border-t border-line pb-3">
      {sizes.length > 0 ? (
        <fieldset className="pt-3">
          <legend className="px-5 pb-1">
            <span className="text-[15px] font-extrabold">{t("Choose a size", "साइज़ चुनें")}</span>
            <span className="ml-2 text-[12px] font-semibold text-muted">{t("Required", "ज़रूरी")}</span>
          </legend>
          {sizes.map((v) => {
            const on = choice.variantId === v.id;
            return (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!v.available}
                onClick={() => onChange({ ...choice, variantId: v.id })}
                className={row}
              >
                <span className={mark(on, true)}>
                  {on ? <span className="size-2 rounded-full bg-[var(--on-accent)]" /> : null}
                </span>
                <span className="flex-1 text-[15px]">{v.name}</span>
                <span className="text-data text-[15px] font-semibold">
                  {v.available ? formatINR(v.price) : t("Sold out", "ख़त्म")}
                </span>
              </button>
            );
          })}
        </fieldset>
      ) : null}
      {(item.addonGroups ?? []).map((g) => {
        const single = g.maxSelect === 1;
        const pickedHere = g.addons.filter((a) => choice.addonIds.includes(a.id)).length;
        return (
          <fieldset key={g.id} className="pt-3">
            <legend className="px-5 pb-1">
              <span className="text-[15px] font-extrabold">{g.name}</span>
              <span className="ml-2 text-[12px] font-semibold text-muted">{rule(g)}</span>
            </legend>
            {g.addons.map((a) => {
              const on = choice.addonIds.includes(a.id);
              const full = !on && !single && pickedHere >= g.maxSelect;
              return (
                <button
                  key={a.id}
                  type="button"
                  role={single ? "radio" : "checkbox"}
                  aria-checked={on}
                  disabled={!a.available || full}
                  onClick={() => toggleAddon(g, a.id)}
                  className={row}
                >
                  <span className={mark(on, single)}>
                    {on ? (
                      <span className={`${single ? "size-2 rounded-full" : "size-2.5 rounded-sm"} bg-[var(--on-accent)]`} />
                    ) : null}
                  </span>
                  <span className="flex-1 text-[15px]">{a.name}</span>
                  <span className="text-data text-[15px] font-semibold text-muted">
                    {a.available ? (a.price > 0 ? `+${formatINR(a.price)}` : t("Free", "मुफ़्त")) : t("Sold out", "ख़त्म")}
                  </span>
                </button>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
