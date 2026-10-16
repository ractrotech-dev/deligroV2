"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formString } from "@/lib/utils/form-data";
import {
  CategoryImagesNotMigratedError,
  setCategoryImage,
} from "@/lib/data-access/category-images";
import { HOME_CATEGORIES } from "@/lib/taxonomy";

export interface CategoryImageResult {
  ok: boolean;
  error?: string;
}

/**
 * Hosts the CSP will actually load an image from (see next.config.ts `img-src`).
 *
 * Checked here to turn a silent failure into a refused save: a URL on any other
 * host stores fine, passes the database's https constraint, and then renders as
 * a blank tile with a console error no operator will ever see. The CSP stays the
 * enforcement; this is the explanation.
 */
const ALLOWED_IMAGE_HOSTS = [/^images\.unsplash\.com$/i, /\.supabase\.co$/i];

function hostAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return ALLOWED_IMAGE_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

export async function setCategoryImageAction(
  _prev: CategoryImageResult,
  form: FormData
): Promise<CategoryImageResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      error: "Demo mode: connect Supabase to save category pictures.",
    };
  }

  const id = formString(form, "id").trim();
  // Only ids the app actually renders. A public server action takes whatever the
  // caller posts, and without this the table would accept rows for categories
  // that do not exist — orphans nothing displays and nobody can find to delete.
  if (!HOME_CATEGORIES.some((c) => c.id === id)) {
    return { ok: false, error: "Unknown category." };
  }

  const raw = formString(form, "imageUrl").trim();

  if (raw && !hostAllowed(raw)) {
    return {
      ok: false,
      error:
        "That URL won't load: pictures must be https and hosted on images.unsplash.com or your Supabase storage. Upload the photo to Supabase and paste its public URL.",
    };
  }

  try {
    await setCategoryImage(id, raw || null);
  } catch (err) {
    if (err instanceof CategoryImagesNotMigratedError) {
      return {
        ok: false,
        error:
          "Apply migration 0037_category_images.sql to save category pictures.",
      };
    }
    return { ok: false, error: "Couldn't save that picture. Try again." };
  }

  // The strip is on the customer home page, which is where the change has to
  // show up — revalidating only the admin route would confirm a save nobody sees.
  revalidatePath("/", "layout");
  revalidatePath("/admin/storage");
  revalidatePath("/admin/settings/categories");
  return { ok: true };
}
