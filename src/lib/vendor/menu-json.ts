import type { VendorMenuItem } from "@/lib/data-access/vendor-menu";

/** One dish as the Partner app reads it. `id` is the row's uuid. */
export function menuItemJson(m: VendorMenuItem) {
  return {
    id: m.dbId,
    name: m.name,
    description: m.description,
    price: m.price,
    category: m.category,
    veg: m.veg,
    available: !m.soldOut,
    popular: m.popular ?? false,
    bestseller: m.bestseller ?? false,
    imageUrl: m.image ?? null,
    sortOrder: m.sortOrder,
    soldCount: m.soldCount,
    soldRevenue: m.soldRevenue,
    stockQty: m.stockQty,
    lowStockAt: m.lowStockAt,
    soldOutByStock: m.soldOutByStock,
    availableDays: m.availableDays,
    availableFrom: m.availableFrom,
    availableTo: m.availableTo,
    variants: m.variants,
    addonGroups: m.addonGroups,
    // What Deligro has done to the dish (0146): it may be hidden, or a price may
    // be parked, while the shop's own switch still says on sale.
    approvalStatus: m.approvalStatus,
    pendingPrice: m.pendingPrice,
    hidden: m.hidden,
    hiddenReason: m.hiddenReason,
    approvalNote: m.approvalNote,
  };
}
