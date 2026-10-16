import { STORE_CATEGORIES } from "@/lib/taxonomy";
import type { PlatformSettings } from "@/types";

/**
 * Which storefront categories are actually on offer.
 *
 * `platform_settings.feature_grocery` / `feature_pick_drop` are editable in the
 * admin Settings tab, validated, clamped and written to the database — and were
 * read by no customer-facing code at all. An admin switching Groceries off to
 * handle a supplier outage got a "Saved" confirmation and a storefront where the
 * category tile, the grocery hero and its WhatsApp CTA all carried on taking
 * orders. This is the consumer that was missing.
 *
 * Pure, and shared by the category strip and the Stores page, so a category
 * cannot be hidden from one and reachable from the other — a tile that is gone
 * but whose `?category=` link still works is the same bug wearing a hat.
 *
 * ## feature_pharmacy
 *
 * There is no pharmacy category, hero or vertical in the product, so it gates
 * no category here. It does gate BANNERS (below): a "Medicines at your door"
 * campaign pointed customers at a service that does not exist. The toggle is
 * not on the Settings form; the column defaults off and is flipped in the
 * database the day a pharmacy vertical ships.
 */
const CATEGORY_FEATURE: Record<string, keyof PlatformSettings> = {
  groceries: "featureGrocery",
  "pick-drop": "featurePickDrop",
};

function isStoreCategoryEnabled(
  id: string,
  settings: Pick<PlatformSettings, "featureGrocery" | "featurePickDrop">
): boolean {
  const flag = CATEGORY_FEATURE[id];
  if (!flag) return true;
  return Boolean((settings as Record<string, unknown>)[flag]);
}

/**
 * Should a banner pointing at this target be shown?
 *
 * Same flags as the categories. Banners were the gap: switching Pick & Drop off
 * hid its category tile, but the home carousel went on advertising "Pick &
 * Drop, anywhere" and "Medicines at your door" — the first two things a
 * customer saw on the home screen, for services the launch doesn't offer
 * (Bemetara launch scope, 28 Sept 2026: food, grocery and dairy only).
 */
export function isBannerTargetEnabled(
  type: string,
  settings: Pick<PlatformSettings, "featureGrocery" | "featurePickDrop" | "featurePharmacy">
): boolean {
  if (type === "grocery") return settings.featureGrocery;
  if (type === "pick_drop") return settings.featurePickDrop;
  if (type === "pharmacy") return settings.featurePharmacy;
  return true;
}

export function enabledStoreCategories(
  settings: Pick<PlatformSettings, "featureGrocery" | "featurePickDrop">
) {
  return STORE_CATEGORIES.filter((c) => isStoreCategoryEnabled(c.id, settings));
}
