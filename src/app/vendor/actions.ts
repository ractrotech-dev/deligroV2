"use server";

import { cookies } from "next/headers";
import { assertVendorFeature } from "@/lib/features/guards.server";
import { revalidatePath } from "next/cache";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import {
  listOwnedRestaurants,
  setRestaurantOpen,
  setVendorBusy,
  updateVendorRestaurant,
  VENDOR_RESTAURANT_COOKIE,
  type VendorRestaurantUpdateInput,
} from "@/lib/data-access/vendor-restaurant";
import {
  bulkSetAvailable,
  bulkSetFlags,
  createMenuItem,
  deleteMenuItem,
  deleteMenuItems,
  duplicateMenuItem,
  mergeCategory,
  renameCategory,
  reorderMenuItems,
  updateMenuItem,
  type MenuItemInput,
} from "@/lib/data-access/vendor-menu";

/*
 * Every action below also checks its feature switch (Admin → Feature access),
 * after the role check: a hidden button is not a disabled endpoint.
 * setActiveRestaurantAction is not switchable — choosing which of your own
 * shops to work in is not a feature.
 */
async function requireRestaurantRole() {
  const profile = await getProfile();
  // Restaurant role, admin, or any shop owner (customer who also runs a shop).
  if (!(await hasVendorAccess(profile))) throw new Error("forbidden");
  return profile!;
}

function revalidateVendorMenu() {
  revalidatePath("/vendor/menu");
  revalidatePath("/vendor/profile");
}

export async function setRestaurantOpenAction(isOpen: boolean) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.open_toggle");
  await setRestaurantOpen(isOpen);
  revalidatePath("/vendor", "layout");
}

export async function updateVendorRestaurantAction(
  input: VendorRestaurantUpdateInput
) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.shop_profile");
  const ok = await updateVendorRestaurant(input);
  if (!ok) throw new Error("not_found");
  revalidatePath("/vendor", "layout");
  revalidatePath("/vendor/profile");
  return { ok: true as const };
}

/**
 * "Kitchen is slammed — quote longer for the next hour."
 *
 * Revalidates the customer tree as well as the vendor's: the whole point is that
 * shoppers see the longer band before they order, so the cards have to rebuild.
 */
export async function setVendorBusyAction(minutes: number, forMinutes = 60) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.busy_mode");
  const ok = await setVendorBusy({ minutes, forMinutes });
  if (!ok) throw new Error("not_found");
  revalidatePath("/vendor", "layout");
  revalidatePath("/", "layout");
  return { ok: true as const };
}

export async function setActiveRestaurantAction(slug: string) {
  await requireRestaurantRole();
  const owned = await listOwnedRestaurants();
  if (!owned.some((r) => r.slug === slug)) throw new Error("forbidden");

  const jar = await cookies();
  jar.set(VENDOR_RESTAURANT_COOKIE, slug, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
  revalidatePath("/vendor", "layout");
}

export async function createMenuItemAction(input: MenuItemInput) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const id = await createMenuItem(input);
  if (!id) throw new Error("not_found");
  revalidateVendorMenu();
  return { ok: true as const, id };
}

export async function updateMenuItemAction(
  menuItemId: string,
  input: Partial<MenuItemInput>
) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const ok = await updateMenuItem(menuItemId, input);
  if (!ok) throw new Error("not_found");
  revalidateVendorMenu();
  return { ok: true as const };
}

export async function deleteMenuItemAction(menuItemId: string) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const ok = await deleteMenuItem(menuItemId);
  if (!ok) throw new Error("not_found");
  revalidateVendorMenu();
  return { ok: true as const };
}

export async function deleteMenuItemsAction(menuItemIds: string[]) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const count = await deleteMenuItems(menuItemIds);
  revalidateVendorMenu();
  return { ok: true as const, count };
}

export async function bulkSetAvailableAction(
  menuItemIds: string[],
  available: boolean
) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const count = await bulkSetAvailable(menuItemIds, available);
  revalidateVendorMenu();
  return { ok: true as const, count };
}

export async function bulkSetFlagsAction(
  menuItemIds: string[],
  flags: { popular?: boolean; bestseller?: boolean }
) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const count = await bulkSetFlags(menuItemIds, flags);
  revalidateVendorMenu();
  return { ok: true as const, count };
}

export async function renameCategoryAction(from: string, to: string) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const count = await renameCategory(from, to);
  revalidateVendorMenu();
  return { ok: true as const, count };
}

export async function mergeCategoryAction(from: string, into: string) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const count = await mergeCategory(from, into);
  revalidateVendorMenu();
  return { ok: true as const, count };
}

export async function reorderMenuItemsAction(orderedIds: string[]) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const ok = await reorderMenuItems(orderedIds);
  if (!ok) throw new Error("not_found");
  revalidateVendorMenu();
  return { ok: true as const };
}

export async function duplicateMenuItemAction(menuItemId: string) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const id = await duplicateMenuItem(menuItemId);
  if (!id) throw new Error("not_found");
  revalidateVendorMenu();
  return { ok: true as const, id };
}

export async function updateMenuItemPriceAction(
  menuItemId: string,
  price: number
) {
  await requireRestaurantRole();
  await assertVendorFeature("vendor.menu_edit");
  const ok = await updateMenuItem(menuItemId, { price });
  if (!ok) throw new Error("not_found");
  revalidateVendorMenu();
  return { ok: true as const };
}
