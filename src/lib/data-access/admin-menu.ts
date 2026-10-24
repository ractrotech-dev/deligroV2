import "server-only";
import { createClient } from "@/lib/supabase/server";
import { autoMatchImage } from "@/lib/data-access/food-images";

/**
 * Admin menu management over `menu_items`. Admins ride the "menu — owner manage"
 * RLS policy (which grants `is_admin()`), so the cookie-bound client is enough.
 * `price`/`discount_price` are whole rupees (integers).
 */

export interface AdminMenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discountPrice: number | null;
  veg: boolean;
  available: boolean;
  category: string | null;
  imageUrl: string | null;
  /** Which library photo this came from, or null for a vendor's own upload. */
  imageLibraryId: string | null;
}

export interface MenuItemInput {
  name: string;
  description: string | null;
  price: number;
  discountPrice: number | null;
  veg: boolean;
  available: boolean;
  category: string | null;
  imageUrl: string | null;
  /** Which library photo this came from, or null for a vendor's own upload. */
  imageLibraryId?: string | null;
}

interface MenuRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discount_price: number | null;
  veg: boolean;
  available: boolean;
  category: string | null;
  image_url: string | null;
  image_library_id?: string | null;
}

const SELECT =
  "id, name, description, price, discount_price, veg, available, category, image_url";

function isMissingSchema(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

function mapItem(row: MenuRow): AdminMenuItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    discountPrice: row.discount_price,
    veg: row.veg,
    available: row.available,
    category: row.category,
    imageUrl: row.image_url,
    imageLibraryId: row.image_library_id ?? null,
  };
}

function toRow(input: MenuItemInput) {
  return {
    name: input.name,
    description: input.description,
    price: Math.max(0, Math.trunc(input.price)),
    discount_price:
      input.discountPrice == null ? null : Math.max(0, Math.trunc(input.discountPrice)),
    veg: input.veg,
    available: input.available,
    category: input.category,
    image_url: input.imageUrl,
  };
}

export async function listMenuItems(restaurantId: string): Promise<AdminMenuItem[]> {
  const supabase = await createClient();

  const read = (columns: string) =>
    supabase
      .from("menu_items")
      .select(columns)
      .eq("restaurant_id", restaurantId)
      .order("category", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true });

  // `image_library_id` only exists from 0035. Asked for separately from the
  // rest so a database without it loses the provenance note, not the menu —
  // this function answers [] on a schema error, and an empty menu screen is a
  // far worse way to learn a migration is missing.
  const withProvenance = await read(`${SELECT}, image_library_id`);
  if (!withProvenance.error) {
    return ((withProvenance.data as unknown as MenuRow[] | null) ?? []).map(
      mapItem
    );
  }
  if (!isMissingSchema(withProvenance.error)) throw withProvenance.error;

  const { data, error } = await read(SELECT);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return ((data as unknown as MenuRow[] | null) ?? []).map(mapItem);
}

/**
 * Attach the library photo this dish name matches, when nobody chose one.
 *
 * Only fills a blank — an explicit choice, including "no picture", is never
 * overwritten. Returns the columns to merge into the row, or `{}`:
 *   * before migration 0035 there is no library and no column, so `{}` keeps
 *     the insert working exactly as it did; and
 *   * an ambiguous name ("Biryani") deliberately matches nothing, because the
 *     right answer to ambiguity is an empty slot someone fills, not a
 *     confident guess that puts mutton on a vegetarian dish.
 */
async function autoImageColumns(
  input: { name: string; imageUrl: string | null }
): Promise<Record<string, unknown>> {
  if (input.imageUrl) return {};
  try {
    const match = await autoMatchImage(input.name);
    if (!match) return {};
    return {
      image_url: match.image.imageUrl,
      image_library_id: match.image.id,
    };
  } catch {
    // The library is a convenience. A menu item must still save without it.
    return {};
  }
}

/**
 * Insert, retrying without `image_library_id` on a database that predates 0035.
 * The photo still lands — `image_url` is what renders — only the note of where
 * it came from is lost.
 */
async function insertMenuRows(
  rows: Record<string, unknown>[]
): Promise<{ id: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .insert(rows)
    .select("id");
  if (!error) return (data ?? []) as { id: string }[];
  if (!isMissingSchema(error)) throw error;

  const stripped = rows.map((row) => {
    const rest = { ...row };
    delete rest.image_library_id;
    return rest;
  });
  const retry = await supabase.from("menu_items").insert(stripped).select("id");
  if (retry.error) throw retry.error;
  return (retry.data ?? []) as { id: string }[];
}

export async function createMenuItem(
  restaurantId: string,
  input: MenuItemInput
): Promise<string> {
  const auto = await autoImageColumns(input);
  const [row] = await insertMenuRows([
    { restaurant_id: restaurantId, ...toRow(input), ...auto },
  ]);
  if (!row) throw new Error("item_not_created");
  return row.id;
}

export async function updateMenuItem(
  itemId: string,
  input: MenuItemInput
): Promise<void> {
  const supabase = await createClient();
  // No auto-match on edit. Someone is looking at this item and has said what
  // its picture should be; silently re-matching it would undo a correction the
  // moment it was made.
  const { error } = await supabase
    .from("menu_items")
    .update(toRow(input))
    .eq("id", itemId);
  if (error) throw error;
}

/**
 * Record where an item's picture came from, alongside the picture itself.
 * `libraryId` is null when a vendor uploaded their own file.
 */
export async function setMenuItemImage(
  itemId: string,
  imageUrl: string | null,
  libraryId: string | null
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("menu_items")
    .update({ image_url: imageUrl, image_library_id: libraryId })
    .eq("id", itemId);
  if (!error) return;
  if (!isMissingSchema(error)) throw error;

  const retry = await supabase
    .from("menu_items")
    .update({ image_url: imageUrl })
    .eq("id", itemId);
  if (retry.error) throw retry.error;
}

export async function deleteMenuItem(itemId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("menu_items").delete().eq("id", itemId);
  if (error) throw error;
}

export async function setMenuItemAvailable(
  itemId: string,
  available: boolean
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("menu_items")
    .update({ available })
    .eq("id", itemId);
  if (error) throw error;
}
