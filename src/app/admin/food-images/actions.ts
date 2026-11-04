"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  deleteFoodImage,
  foodImageFromDrive,
  searchImagesWithDrive,
  suggestImagesWithDrive,
  updateFoodImage,
  DuplicateTitleError,
  type FoodImage,
} from "@/lib/data-access/food-images";

/**
 * Server Actions for the food photo library.
 *
 * Every exported function starts with requireRole("admin") — these are public
 * HTTP endpoints, "internal helper" or not (AGENTS.md §3). The two read actions
 * are gated too: the rows themselves are world-readable, but an un-gated action
 * that runs an arbitrary query for anyone who can guess its id is a habit worth
 * not forming.
 */

export interface ImageActionResult {
  ok: boolean;
  error?: string;
}

const DEMO = "Demo mode: connect Supabase and apply 0035 to manage food photos.";

export async function updateFoodImageAction(
  id: string,
  input: { title: string; description?: string; tags?: string[]; veg?: boolean | null }
): Promise<ImageActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };
  if (!input.title?.trim()) return { ok: false, error: "Give the photo a name." };

  try {
    await updateFoodImage(id, input);
  } catch (err) {
    if (err instanceof DuplicateTitleError) {
      return {
        ok: false,
        error: `There is already a photo called “${err.title}”.`,
      };
    }
    return { ok: false, error: "Couldn't save that photo. Try again." };
  }

  revalidatePath("/admin/storage");
  return { ok: true };
}

export async function deleteFoodImageAction(
  id: string
): Promise<ImageActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { ok: false, error: DEMO };

  try {
    const result = await deleteFoodImage(id);
    if ("error" in result) return { ok: false, error: result.error };
  } catch {
    return { ok: false, error: "Couldn't delete that photo. Try again." };
  }

  revalidatePath("/admin/storage");
  return { ok: true };
}

/** Search the library from the picker, as the operator types. */
export async function searchFoodImagesAction(
  query: string
): Promise<{ images: FoodImage[] }> {
  await requireRole("admin");
  if (!isSupabaseConfigured) return { images: [] };
  try {
    return { images: await searchImagesWithDrive(query.trim()) };
  } catch {
    return { images: [] };
  }
}

/**
 * Ranked suggestions for one dish name — what the picker opens on.
 *
 * Returns the score and the reason alongside each photo so the UI can say
 * "matches on chicken, biryani" rather than presenting an unexplained order.
 */
export async function suggestFoodImagesAction(
  dishName: string
): Promise<{ suggestions: { image: FoodImage; score: number; reason: string }[] }> {
  await requireRole("admin");
  if (!isSupabaseConfigured || !dishName.trim()) return { suggestions: [] };
  try {
    return { suggestions: await suggestImagesWithDrive(dishName.trim()) };
  } catch {
    return { suggestions: [] };
  }
}

/** A photo picked from the owner's Drive: copied into storage, ready to set on the dish. */
export async function foodImageFromDriveAction(
  driveFileId: string
): Promise<{ image: FoodImage | null; error?: string }> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`drive-pick:${admin.id}`, 60, 60_000);
  if (!limit.ok) return { image: null, error: "Too many at once. Wait a moment." };
  try {
    return { image: await foodImageFromDrive(String(driveFileId), admin.id) };
  } catch {
    return { image: null };
  }
}
