import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readAllRows } from "@/lib/data-access/read-all";
import type { MenuItem } from "@/types";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";

interface DbMenuItem {
  id: string;
  external_id: string | null;
  name: string;
  description: string | null;
  price: number;
  veg: boolean;
  available: boolean;
  category: string | null;
  image_url: string | null;
  popular: boolean;
  bestseller: boolean;
  sort_order: number;
  created_at?: string | null;
}

export type VendorMenuItem = MenuItem & {
  dbId: string;
  externalId: string | null;
  sortOrder: number;
  createdAt: string | null;
  /** Units sold (non-cancelled orders). */
  soldCount: number;
  /** Revenue from those sales (rupees). */
  soldRevenue: number;
};

export interface MenuItemInput {
  name: string;
  description?: string;
  price: number;
  category: string;
  veg: boolean;
  available?: boolean;
  popular?: boolean;
  bestseller?: boolean;
  imageUrl?: string;
  externalId?: string | null;
  sortOrder?: number;
}

export interface MenuImportRow {
  externalId?: string | null;
  name: string;
  category: string;
  price: number;
  description?: string;
  veg?: boolean;
  available?: boolean;
  popular?: boolean;
  bestseller?: boolean;
  imageUrl?: string | null;
}

function mapMenuItem(
  row: DbMenuItem,
  sales?: { soldCount: number; soldRevenue: number }
): VendorMenuItem {
  return {
    dbId: row.id,
    id: row.external_id ?? row.id,
    externalId: row.external_id,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at ?? null,
    name: row.name,
    description: row.description ?? "",
    price: row.price,
    category: row.category ?? "Popular",
    veg: row.veg,
    image: row.image_url ?? undefined,
    soldOut: !row.available,
    popular: row.popular,
    bestseller: row.bestseller,
    soldCount: sales?.soldCount ?? 0,
    soldRevenue: sales?.soldRevenue ?? 0,
  };
}

function normalizeInput(input: MenuItemInput) {
  const name = input.name.trim();
  const category = input.category.trim() || "Popular";
  const price = Math.round(input.price);
  if (!name) throw new Error("name_required");
  if (price < 0) throw new Error("invalid_price");
  const externalId = input.externalId?.trim() || null;
  const row: Record<string, unknown> = {
    name,
    description: input.description?.trim() || null,
    price,
    category,
    veg: input.veg,
    available: input.available ?? true,
    popular: input.popular ?? false,
    bestseller: input.bestseller ?? false,
    image_url: input.imageUrl?.trim() || null,
    external_id: externalId,
  };
  if (input.sortOrder !== undefined) row.sort_order = input.sortOrder;
  return row;
}

async function requireOwnedRestaurant() {
  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) return null;
  return restaurant;
}

const SALE_STATUSES = [
  "kitchen",
  "ready",
  "on_the_way",
  "delivered",
] as const;

/** Aggregate units sold + revenue per menu_item_id for this restaurant. */
async function loadMenuItemSales(
  restaurantId: string
): Promise<Map<string, { soldCount: number; soldRevenue: number }>> {
  const supabase = await createClient();
  const map = new Map<string, { soldCount: number; soldRevenue: number }>();

  // Paged (read-all.ts): "units sold" is a count of every order line the shop
  // ever sold, which outgrows PostgREST's 1000-row cap quickly.
  const { data, error } = await readAllRows((from, to) =>
    supabase
      .from("order_items")
      .select("menu_item_id, qty, price, orders!inner(restaurant_id, status)")
      .eq("orders.restaurant_id", restaurantId)
      .in("orders.status", [...SALE_STATUSES])
      .not("menu_item_id", "is", null)
      .order("id")
      .range(from, to)
  );

  if (error) {
    // Don't fail the whole menu if sales join isn't available
    return map;
  }

  for (const row of data ?? []) {
    const id = row.menu_item_id as string | null;
    if (!id) continue;
    const qty = Number(row.qty) || 0;
    const unit = Number(row.price) || 0;
    const existing = map.get(id) ?? { soldCount: 0, soldRevenue: 0 };
    existing.soldCount += qty;
    existing.soldRevenue += qty * unit;
    map.set(id, existing);
  }

  return map;
}

/** Menu for the signed-in vendor's active restaurant. */
export async function listOwnedMenuItems(): Promise<{
  restaurantId: string;
  restaurantName: string;
  categories: string[];
  items: VendorMenuItem[];
} | null> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return null;

  const supabase = await createClient();
  let data: DbMenuItem[] | null = null;

  const primary = await supabase
    .from("menu_items")
    .select(
      "id, external_id, name, description, price, veg, available, category, image_url, popular, bestseller, sort_order, created_at"
    )
    .eq("restaurant_id", restaurant.id)
    .order("sort_order", { ascending: true })
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (primary.error) {
    // Pre-migration fallback if sort_order is not applied yet
    const fallback = await supabase
      .from("menu_items")
      .select(
        "id, external_id, name, description, price, veg, available, category, image_url, popular, bestseller, created_at"
      )
      .eq("restaurant_id", restaurant.id)
      .order("category")
      .order("name");
    if (fallback.error) throw fallback.error;
    data = ((fallback.data ?? []) as Omit<DbMenuItem, "sort_order">[]).map(
      (row) => ({ ...row, sort_order: 0 })
    );
  } else {
    data = (primary.data ?? []) as DbMenuItem[];
  }

  const salesByItem = await loadMenuItemSales(restaurant.id);
  const items = data.map((row) =>
    mapMenuItem(row, salesByItem.get(row.id))
  );
  const categories = Array.from(
    new Set(items.map((m) => m.category).filter(Boolean))
  ).sort((a, b) => {
    if (a === "Popular") return -1;
    if (b === "Popular") return 1;
    return a.localeCompare(b);
  });

  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    categories,
    items,
  };
}

export async function createMenuItem(
  input: MenuItemInput
): Promise<string | null> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return null;

  const row = normalizeInput(input);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .insert({ restaurant_id: restaurant.id, ...row })
    .select("id")
    .single();

  if (error) throw error;
  return data?.id ?? null;
}

export async function updateMenuItem(
  menuItemId: string,
  input: Partial<MenuItemInput>
): Promise<boolean> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return false;

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name_required");
    patch.name = name;
  }
  if (input.description !== undefined)
    patch.description = input.description.trim() || null;
  if (input.price !== undefined) {
    const price = Math.round(input.price);
    if (price < 0) throw new Error("invalid_price");
    patch.price = price;
  }
  if (input.category !== undefined)
    patch.category = input.category.trim() || "Popular";
  if (input.veg !== undefined) patch.veg = input.veg;
  if (input.available !== undefined) patch.available = input.available;
  if (input.popular !== undefined) patch.popular = input.popular;
  if (input.bestseller !== undefined) patch.bestseller = input.bestseller;
  if (input.imageUrl !== undefined)
    patch.image_url = input.imageUrl.trim() || null;
  if (input.externalId !== undefined)
    patch.external_id = input.externalId?.trim() || null;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;

  if (Object.keys(patch).length === 0) return false;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .update(patch)
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurant.id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}

export async function deleteMenuItem(menuItemId: string): Promise<boolean> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return false;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .delete()
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurant.id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}

export async function deleteMenuItems(menuItemIds: string[]): Promise<number> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant || menuItemIds.length === 0) return 0;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .delete()
    .eq("restaurant_id", restaurant.id)
    .in("id", menuItemIds)
    .select("id");

  if (error) throw error;
  return data?.length ?? 0;
}

export async function setMenuItemAvailable(
  menuItemId: string,
  available: boolean
): Promise<boolean> {
  return updateMenuItem(menuItemId, { available });
}

export async function bulkSetAvailable(
  menuItemIds: string[],
  available: boolean
): Promise<number> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant || menuItemIds.length === 0) return 0;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .update({ available })
    .eq("restaurant_id", restaurant.id)
    .in("id", menuItemIds)
    .select("id");

  if (error) throw error;
  return data?.length ?? 0;
}

/** Bulk set popular and/or bestseller flags. */
export async function bulkSetFlags(
  menuItemIds: string[],
  flags: { popular?: boolean; bestseller?: boolean }
): Promise<number> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant || menuItemIds.length === 0) return 0;

  const patch: Record<string, boolean> = {};
  if (flags.popular !== undefined) patch.popular = flags.popular;
  if (flags.bestseller !== undefined) patch.bestseller = flags.bestseller;
  if (Object.keys(patch).length === 0) return 0;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .update(patch)
    .eq("restaurant_id", restaurant.id)
    .in("id", menuItemIds)
    .select("id");

  if (error) throw error;
  return data?.length ?? 0;
}

/** Rename category text for all items at the active restaurant. */
export async function renameCategory(
  from: string,
  to: string
): Promise<number> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return 0;

  const source = from.trim();
  const target = to.trim() || "Popular";
  if (!source || source === target) return 0;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .update({ category: target })
    .eq("restaurant_id", restaurant.id)
    .eq("category", source)
    .select("id");

  if (error) throw error;
  return data?.length ?? 0;
}

/** Move all items from one category into another (merge). */
export async function mergeCategory(
  from: string,
  into: string
): Promise<number> {
  return renameCategory(from, into);
}

export interface MenuImportResult {
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

/** Upsert by external_id when present; otherwise insert. Cap 500 rows. */
export async function upsertMenuItemsFromImport(
  rows: MenuImportRow[]
): Promise<MenuImportResult> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) {
    return { created: 0, updated: 0, failed: 0, errors: ["No restaurant"] };
  }

  const capped = rows.slice(0, 500);
  const supabase = await createClient();
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  const externalIds = capped
    .map((r) => r.externalId?.trim())
    .filter((id): id is string => Boolean(id));

  const existingByExternal = new Map<string, string>();
  if (externalIds.length > 0) {
    const { data: existing, error: existingError } = await supabase
      .from("menu_items")
      .select("id, external_id")
      .eq("restaurant_id", restaurant.id)
      .in("external_id", externalIds);
    if (existingError) {
      return {
        created: 0,
        updated: 0,
        failed: capped.length,
        errors: [existingError.message],
      };
    }
    for (const row of existing ?? []) {
      if (row.external_id) existingByExternal.set(row.external_id, row.id);
    }
  }

  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];

  capped.forEach((r) => {
    const name = r.name?.trim() ?? "";
    const price = Math.round(Number(r.price));
    if (!name) {
      failed += 1;
      errors.push("Row skipped: name is required");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      failed += 1;
      errors.push(`Row skipped (${name}): invalid price`);
      return;
    }

    const externalId = r.externalId?.trim() || null;
    const base: Record<string, unknown> = {
      name,
      category: r.category?.trim() || "Popular",
      price,
      description: r.description?.trim() || null,
      veg: r.veg ?? true,
      available: r.available ?? true,
      popular: r.popular ?? false,
      bestseller: r.bestseller ?? false,
      image_url: r.imageUrl?.trim() || null,
    };

    if (externalId && existingByExternal.has(externalId)) {
      toUpdate.push({
        id: existingByExternal.get(externalId)!,
        patch: { ...base, external_id: externalId },
      });
    } else {
      toInsert.push({
        restaurant_id: restaurant.id,
        ...base,
        external_id: externalId,
      });
    }
  });

  for (const item of toUpdate) {
    const { error } = await supabase
      .from("menu_items")
      .update(item.patch)
      .eq("id", item.id)
      .eq("restaurant_id", restaurant.id);
    if (error) {
      failed += 1;
      errors.push(error.message);
    } else {
      updated += 1;
    }
  }

  if (toInsert.length > 0) {
    const { data, error } = await supabase
      .from("menu_items")
      .insert(toInsert)
      .select("id");
    if (error) {
      failed += toInsert.length;
      errors.push(error.message);
    } else {
      created += data?.length ?? 0;
    }
  }

  return { created, updated, failed, errors };
}

/** Persist display order (0..n-1) for the active restaurant. */
export async function reorderMenuItems(
  orderedIds: string[]
): Promise<boolean> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant || orderedIds.length === 0) return false;

  const supabase = await createClient();
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase
        .from("menu_items")
        .update({ sort_order: index })
        .eq("id", id)
        .eq("restaurant_id", restaurant.id)
        .select("id")
        .maybeSingle()
    )
  );

  for (const r of results) {
    if (r.error) throw r.error;
  }
  return true;
}

/** Clone an item with a “(copy)” name suffix. */
export async function duplicateMenuItem(
  menuItemId: string
): Promise<string | null> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return null;

  const supabase = await createClient();
  const { data: source, error } = await supabase
    .from("menu_items")
    .select(
      "name, description, price, veg, available, category, image_url, popular, bestseller, sort_order"
    )
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (error) throw error;
  if (!source) return null;

  const baseName = source.name.replace(/\(copy\)\s*$/i, "").trim();
  const { data, error: insertError } = await supabase
    .from("menu_items")
    .insert({
      restaurant_id: restaurant.id,
      name: `${baseName} (copy)`,
      description: source.description,
      price: source.price,
      veg: source.veg,
      available: source.available,
      category: source.category,
      image_url: source.image_url,
      popular: false,
      bestseller: false,
      sort_order: (source.sort_order ?? 0) + 1,
      external_id: null,
    })
    .select("id")
    .single();

  if (insertError) throw insertError;
  return data?.id ?? null;
}
