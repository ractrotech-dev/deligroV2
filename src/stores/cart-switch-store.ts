"use client";

import { create } from "zustand";
import type { MenuItem } from "@/types";
import { useCart } from "@/stores/cart-store";

/**
 * The one-restaurant-per-cart rule, made visible.
 *
 * `useCart.add` silently drops the existing lines when the dish comes from a
 * different kitchen. That was survivable while every Add lived inside one
 * restaurant's menu — you had to walk out of a shop to trigger it. Dish-first
 * search puts food from six kitchens in one list, so the same tap now wipes a
 * cart the customer is still building, with no warning and nothing to undo.
 *
 * So every Add goes through `request`: same shop (or empty cart) adds straight
 * away, a different shop parks the intent here until the customer confirms.
 */
interface PendingAdd {
  item: MenuItem;
  restaurant: { slug: string; name: string };
  /** null = "one more" (the Add pill); a number = "exactly this" (item sheet). */
  qty: number | null;
  /** The cart that would be discarded — named so the prompt can say whose. */
  currentName: string;
  currentCount: number;
}

interface CartSwitchState {
  pending: PendingAdd | null;
  request: (
    item: MenuItem,
    restaurant: { slug: string; name: string },
    qty?: number | null
  ) => void;
  confirm: () => void;
  cancel: () => void;
}

function commit(
  item: MenuItem,
  restaurant: { slug: string; name: string },
  qty: number | null
) {
  const cart = useCart.getState();
  cart.add(item, restaurant); // creates the line (and switches shop if needed)
  if (qty !== null) cart.setQty(item.id, qty);
}

export const useCartSwitch = create<CartSwitchState>((set, get) => ({
  pending: null,

  request: (item, restaurant, qty = null) => {
    const cart = useCart.getState();
    const conflict =
      cart.lines.length > 0 &&
      cart.restaurantSlug !== null &&
      cart.restaurantSlug !== restaurant.slug;

    if (!conflict) {
      commit(item, restaurant, qty);
      return;
    }

    set({
      pending: {
        item,
        restaurant,
        qty,
        currentName: cart.restaurantName ?? "your current basket",
        currentCount: cart.count(),
      },
    });
  },

  confirm: () => {
    const pending = get().pending;
    if (!pending) return;
    commit(pending.item, pending.restaurant, pending.qty);
    set({ pending: null });
  },

  cancel: () => set({ pending: null }),
}));
