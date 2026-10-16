import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * The admin-managed vendor category taxonomy (migration 0017). This is a
 * canonical, orderable, enable/disable list the registration wizard and menu
 * editor pick from — it is NOT foreign-keyed to `menu_items.category`, so
 * renaming or disabling a category never orphans a vendor or a dish.
 *
 * Reads of enabled categories are public (they power customer-facing filters);
 * seeing disabled ones and all writes are admin-only, enforced by RLS.
 */

export interface VendorCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface VendorCategoryInput {
  name: string;
  description: string | null;
  sortOrder: number;
  enabled: boolean;
}

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sort_order: number;
  enabled: boolean;
}

function mapCategory(row: CategoryRow): VendorCategory {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    sortOrder: row.sort_order,
    enabled: row.enabled,
  };
}

/** Table missing (not migrated) — reads degrade to []. */
function isMissingTable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

/** URL-safe slug from a name; caller resolves collisions. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    // The line above collapses every run to one "-", so a single edge dash is
    // all there is to strip.
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

const SELECT = "id, name, slug, description, sort_order, enabled";

export async function listCategories(
  includeDisabled = false
): Promise<VendorCategory[]> {
  const supabase = await createClient();
  let query = supabase
    .from("vendor_categories")
    .select(SELECT)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!includeDisabled) query = query.eq("enabled", true);

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data as CategoryRow[] | null ?? []).map(mapCategory);
}

export async function getCategory(id: string): Promise<VendorCategory | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vendor_categories")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return data ? mapCategory(data as CategoryRow) : null;
}

/**
 * Pick a slug that isn't already taken, suffixing -2, -3, … on collision. The
 * unique index is the real guard; this just avoids a predictable clash for the
 * common case (and lets the wizard's inline "add category" succeed).
 */
async function uniqueSlug(
  supabase: Awaited<ReturnType<typeof createClient>>,
  base: string,
  excludeId?: string
): Promise<string> {
  const root = base || "category";
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    let query = supabase
      .from("vendor_categories")
      .select("id")
      .eq("slug", candidate);
    if (excludeId) query = query.neq("id", excludeId);
    const { data } = await query.maybeSingle();
    if (!data) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export async function createCategory(
  input: VendorCategoryInput
): Promise<string> {
  const supabase = await createClient();
  const slug = await uniqueSlug(supabase, slugify(input.name));
  const { data, error } = await supabase
    .from("vendor_categories")
    .insert({
      name: input.name,
      slug,
      description: input.description,
      sort_order: input.sortOrder,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateCategory(
  id: string,
  input: VendorCategoryInput
): Promise<void> {
  const supabase = await createClient();
  const slug = await uniqueSlug(supabase, slugify(input.name), id);
  const { error } = await supabase
    .from("vendor_categories")
    .update({
      name: input.name,
      slug,
      description: input.description,
      sort_order: input.sortOrder,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

export async function setCategoryEnabled(
  id: string,
  enabled: boolean
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("vendor_categories")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteCategory(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("vendor_categories")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
