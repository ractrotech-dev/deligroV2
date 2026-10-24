"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  setMenuItemAvailable,
  setMenuItemImage,
  type MenuItemInput,
} from "@/lib/data-access/admin-menu";
import { deleteVendorDocument } from "@/lib/data-access/vendor-documents";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase and apply 0019 to manage the menu.";

function revalidateVendor(id: string) {
  revalidatePath(`/admin/vendors/${id}`);
  revalidatePath("/", "layout");
}

async function guard(): Promise<string | null> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return DEMO;
  return null;
}

// ---------- menu ----------

export async function createMenuItemAction(
  restaurantId: string,
  input: MenuItemInput
): Promise<ActionResult & { id?: string }> {
  const demo = await guard();
  if (demo) return { ok: false, error: demo };
  if (!input.name?.trim()) return { ok: false, error: "Item name is required." };
  try {
    const id = await createMenuItem(restaurantId, input);
    revalidateVendor(restaurantId);
    return { ok: true, id };
  } catch {
    return { ok: false, error: "Couldn't add the item." };
  }
}

export async function updateMenuItemAction(
  restaurantId: string,
  itemId: string,
  input: MenuItemInput
): Promise<ActionResult> {
  const demo = await guard();
  if (demo) return { ok: false, error: demo };
  if (!input.name?.trim()) return { ok: false, error: "Item name is required." };
  try {
    await updateMenuItem(itemId, input);
    revalidateVendor(restaurantId);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save the item." };
  }
}

export async function deleteMenuItemAction(
  restaurantId: string,
  itemId: string
): Promise<ActionResult> {
  const demo = await guard();
  if (demo) return { ok: false, error: demo };
  try {
    await deleteMenuItem(itemId);
    revalidateVendor(restaurantId);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't delete the item." };
  }
}

export async function setMenuAvailabilityAction(
  restaurantId: string,
  itemId: string,
  available: boolean
): Promise<ActionResult> {
  const demo = await guard();
  if (demo) return { ok: false, error: demo };
  try {
    await setMenuItemAvailable(itemId, available);
    revalidateVendor(restaurantId);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't update availability." };
  }
}

/**
 * Change which picture a menu item uses.
 *
 * Separate from updateMenuItemAction because the picker is used on its own,
 * without the rest of the form being open — and because this is the one write
 * that also records provenance, so "matched automatically" and "chosen by a
 * person" stay distinguishable.
 */
export async function setMenuItemImageAction(
  restaurantId: string,
  itemId: string,
  imageUrl: string | null,
  libraryId: string | null
): Promise<ActionResult> {
  const demo = await guard();
  if (demo) return { ok: false, error: demo };
  try {
    await setMenuItemImage(itemId, imageUrl, libraryId);
    revalidateVendor(restaurantId);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't change the picture." };
  }
}

// ---------- documents ----------

export async function deleteDocumentAction(
  restaurantId: string,
  docId: string
): Promise<ActionResult> {
  const demo = await guard();
  if (demo) return { ok: false, error: demo };
  try {
    await deleteVendorDocument(docId);
    revalidateVendor(restaurantId);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't delete the document." };
  }
}
