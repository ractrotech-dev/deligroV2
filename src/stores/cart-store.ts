"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartLine, MenuItem } from "@/types";
import { cartLineKey } from "@/lib/utils/cart";
import {
  choiceLabel,
  choicePrice,
  lineKey,
  NO_CHOICE,
  type OptionChoice,
} from "@/lib/orders/order-options";

/**
 * The basket's contents — and nothing about what they cost beyond the line
 * subtotal.
 *
 * This store used to carry `deliveryFee()`, `taxes()` and `total()` computed
 * from the pricing.ts constants. Nothing read them, so they were a fee/tax
 * definition that could silently drift from the one being billed — see the
 * header of `lib/pricing.ts`. Charges are computed from the live platform
 * settings at the point they are shown (`useChargesConfig` +
 * `computeChargesWith`) and recomputed server-side in `createOrder`.
 *
 * A line is a dish plus its chosen size and add-ons (0062), so the same dish
 * in two sizes is two lines. `remove` / `setQty` take that line key
 * (`cartLineKey`); for a dish without options it is simply the dish id.
 */

interface CartState {
  restaurantSlug: string | null;
  restaurantName: string | null;
  lines: CartLine[];
  add: (
    item: MenuItem,
    restaurant: { slug: string; name: string },
    choice?: OptionChoice
  ) => string;
  remove: (key: string) => void;
  setQty: (key: string, qty: number) => void;
  clear: () => void;
  /** Units of this dish in the basket, across all its sizes and add-ons. */
  qtyOf: (itemId: string) => number;
  count: () => number;
  subtotal: () => number;
  reorder: (
    restaurant: { slug: string; name: string },
    lines: CartLine[]
  ) => void;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => {
      const without = (state: CartState, key: string) => {
        const lines = state.lines.filter((l) => cartLineKey(l) !== key);
        return lines.length === 0
          ? { lines, restaurantSlug: null, restaurantName: null }
          : { lines };
      };

      return {
        restaurantSlug: null,
        restaurantName: null,
        lines: [],

        add: (item, restaurant, choice = NO_CHOICE) => {
          const key = lineKey(item.id, choice);
          set((state) => {
            // One restaurant per cart — switching restaurants replaces it.
            const sameRestaurant = state.restaurantSlug === restaurant.slug;
            const baseLines = sameRestaurant ? state.lines : [];
            const existing = baseLines.some((l) => cartLineKey(l) === key);
            const options = choiceLabel(item, choice);
            const lines = existing
              ? baseLines.map((l) =>
                  cartLineKey(l) === key ? { ...l, qty: l.qty + 1 } : l
                )
              : [
                  ...baseLines,
                  {
                    itemId: item.id,
                    ...(key !== item.id
                      ? {
                          key,
                          variantId: choice.variantId,
                          addonIds: choice.addonIds,
                          options,
                        }
                      : {}),
                    name: item.name,
                    price: choicePrice(item, choice),
                    qty: 1,
                    veg: item.veg,
                  },
                ];
            return {
              restaurantSlug: restaurant.slug,
              restaurantName: restaurant.name,
              lines,
            };
          });
          return key;
        },

        remove: (key) => set((state) => without(state, key)),

        setQty: (key, qty) =>
          set((state) => {
            if (qty <= 0) return without(state, key);
            return {
              lines: state.lines.map((l) =>
                cartLineKey(l) === key ? { ...l, qty } : l
              ),
            };
          }),

        clear: () =>
          set({ lines: [], restaurantSlug: null, restaurantName: null }),

        qtyOf: (itemId) =>
          get()
            .lines.filter((l) => l.itemId === itemId)
            .reduce((n, l) => n + l.qty, 0),

        count: () => get().lines.reduce((n, l) => n + l.qty, 0),

        subtotal: () =>
          get().lines.reduce((sum, l) => sum + l.price * l.qty, 0),

        reorder: (restaurant, lines) =>
          set({
            restaurantSlug: restaurant.slug,
            restaurantName: restaurant.name,
            lines: lines.map((l) => ({ ...l })),
          }),
      };
    },
    {
      name: "deligro-cart",
      skipHydration: true,
    }
  )
);
