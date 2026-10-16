"use client";

import { create } from "zustand";
import type { CartLine } from "@/types";
import { useCart } from "@/stores/cart-store";

/**
 * "Order again" used to copy a past order's prices straight into the cart with
 * no check against today's menu — see `reconcileReorder` in `lib/utils/cart.ts`.
 * When nothing changed, reordering stays a single tap. When something did, this
 * parks the reconciled cart here until the customer has seen what changed —
 * same shape as `cart-switch-store.ts` for the one-restaurant-per-cart prompt.
 */
interface PendingReorder {
  restaurant: { slug: string; name: string };
  lines: CartLine[];
  removed: string[];
  repriced: { name: string; oldPrice: number; newPrice: number }[];
}

interface ReorderReviewState {
  pending: PendingReorder | null;
  show: (pending: PendingReorder) => void;
  confirm: () => void;
  cancel: () => void;
}

export const useReorderReview = create<ReorderReviewState>((set, get) => ({
  pending: null,

  show: (pending) => set({ pending }),

  confirm: () => {
    const pending = get().pending;
    if (!pending) return;
    useCart.getState().reorder(pending.restaurant, pending.lines);
    set({ pending: null });
  },

  cancel: () => set({ pending: null }),
}));
