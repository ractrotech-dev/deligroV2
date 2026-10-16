"use server";

import { assertVendorFeature } from "@/lib/features/guards.server";
import { requireVendorAccess } from "@/lib/auth/vendor-access";
import {
  listFoodImages,
  suggestImages,
  type FoodImage,
} from "@/lib/data-access/food-images";

/* ------------------------------------------------------------------
 * The shared food photo library, from the vendor side.
 * ------------------------------------------------------------------
 * Same library, same ranking, same two functions the admin console calls — a
 * vendor changing a wrongly-matched photo has to see exactly what an admin
 * would, or the two will pick different pictures for the same dish.
 *
 * `requireVendorAccess()` first, like every action in this file: these are
 * public HTTP endpoints (AGENTS.md §3). The rows themselves are world-readable
 * by design (the customer app renders them, migration 0035), so the gate is
 * about not offering an ungated query surface rather than about hiding data —
 * and it is the authorization check that sits above the service-role read
 * inside those functions (AGENTS.md §5).
 * ------------------------------------------------------------------ */

/** Ranked photos for a dish name — what the picker opens on. */
export async function suggestVendorFoodImages(
  dishName: string
): Promise<{ suggestions: { image: FoodImage; score: number; reason: string }[] }> {
  await requireVendorAccess();
  await assertVendorFeature("vendor.menu_edit");
  if (!dishName.trim()) return { suggestions: [] };
  try {
    return { suggestions: await suggestImages(dishName.trim()) };
  } catch {
    return { suggestions: [] };
  }
}

/** Free-text search of the library, as the vendor types. */
export async function searchVendorFoodImages(
  query: string
): Promise<{ images: FoodImage[] }> {
  await requireVendorAccess();
  await assertVendorFeature("vendor.menu_edit");
  try {
    return { images: await listFoodImages({ query: query.trim(), limit: 40 }) };
  } catch {
    return { images: [] };
  }
}
