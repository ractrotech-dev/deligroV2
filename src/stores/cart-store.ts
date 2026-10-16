"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartLine, MenuItem } from "@/types";
import { effectivePrice } from "@/lib/utils/cart";

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
 */

interface CartState {
  restaurantSlug: string | null;
  restaurantName: string | null;
  lines: CartLine[];
  add: (item: MenuItem, restaurant: { slug: string; name: string }) => void;
  remove: (itemId: string) => void;
  setQty: (itemId: string, qty: number) => void;
  clear: () => void;
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
    (set, get) => ({
      restaurantSlug: null,
      restaurantName: null,
      lines: [],

      add: (item, restaurant) =>
        set((state) => {
          // One restaurant per cart — switching restaurants replaces it.
          const sameRestaurant = state.restaurantSlug === restaurant.slug;
          const baseLines = sameRestaurant ? state.lines : [];
          const existing = baseLines.some((l) => l.itemId === item.id);
          const lines = existing
            ? baseLines.map((l) =>
                l.itemId === item.id ? { ...l, qty: l.qty + 1 } : l
              )
            : [
                ...baseLines,
                {
                  itemId: item.id,
                  name: item.name,
                  price: effectivePrice(item.price, item.discountPrice),
                  qty: 1,
                  veg: item.veg,
                },
              ];
          return {
            restaurantSlug: restaurant.slug,
            restaurantName: restaurant.name,
            lines,
          };
        }),

      remove: (itemId) =>
        set((state) => {
          const lines = state.lines.filter((l) => l.itemId !== itemId);
          return lines.length === 0
            ? { lines, restaurantSlug: null, restaurantName: null }
            : { lines };
        }),

      setQty: (itemId, qty) =>
        set((state) => {
          if (qty <= 0) {
            const lines = state.lines.filter((l) => l.itemId !== itemId);
            return lines.length === 0
              ? { lines, restaurantSlug: null, restaurantName: null }
              : { lines };
          }
          return {
            lines: state.lines.map((l) =>
              l.itemId === itemId ? { ...l, qty } : l
            ),
          };
        }),

      clear: () =>
        set({ lines: [], restaurantSlug: null, restaurantName: null }),

      qtyOf: (itemId) =>
        get().lines.find((l) => l.itemId === itemId)?.qty ?? 0,

      count: () => get().lines.reduce((n, l) => n + l.qty, 0),

      subtotal: () =>
        get().lines.reduce((sum, l) => sum + l.price * l.qty, 0),

      reorder: (restaurant, lines) =>
        set({
          restaurantSlug: restaurant.slug,
          restaurantName: restaurant.name,
          lines: lines.map((l) => ({ ...l })),
        }),
    }),
    {
      name: "deligro-cart",
      skipHydration: true,
    }
  )
);
