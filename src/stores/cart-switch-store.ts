"use client";

import { create } from "zustand";
import type { MenuItem } from "@/types";
import { NO_CHOICE, type OptionChoice } from "@/lib/orders/order-options";
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
  /** The size and add-ons picked in the item sheet. */
  choice: OptionChoice;
  /** The cart that would be discarded — named so the prompt can say whose. */
  currentName: string;
  currentCount: number;
}

interface CartSwitchState {
  pending: PendingAdd | null;
  request: (
    item: MenuItem,
    restaurant: { slug: string; name: string },
    qty?: number | null,
    choice?: OptionChoice
  ) => void;
  confirm: () => void;
  cancel: () => void;
}

function commit(
  item: MenuItem,
  restaurant: { slug: string; name: string },
  qty: number | null,
  choice: OptionChoice
) {
  const cart = useCart.getState();
  // Creates the line (and switches shop if needed).
  const key = cart.add(item, restaurant, choice);
  if (qty !== null) cart.setQty(key, qty);
}

export const useCartSwitch = create<CartSwitchState>((set, get) => ({
  pending: null,

  request: (item, restaurant, qty = null, choice = NO_CHOICE) => {
    const cart = useCart.getState();
    const conflict =
      cart.lines.length > 0 &&
      cart.restaurantSlug !== null &&
      cart.restaurantSlug !== restaurant.slug;

    if (!conflict) {
      commit(item, restaurant, qty, choice);
      return;
    }

    set({
      pending: {
        item,
        restaurant,
        qty,
        choice,
        currentName: cart.restaurantName ?? "your current basket",
        currentCount: cart.count(),
      },
    });
  },

  confirm: () => {
    const pending = get().pending;
    if (!pending) return;
    commit(pending.item, pending.restaurant, pending.qty, pending.choice);
    set({ pending: null });
  },

  cancel: () => set({ pending: null }),
}));
