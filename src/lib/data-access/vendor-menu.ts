import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readAllRows } from "@/lib/data-access/read-all";
import type { MenuItem } from "@/types";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { MenuOptionsInput } from "@/lib/vendor/menu-input";
import {
  INVENTORY_COLUMN,
  loadMenuOptions,
  type VendorMenuAddonGroup,
  type VendorMenuVariant,
} from "@/lib/data-access/menu-options";

const INVENTORY_SELECT =
  ", stock_qty, low_stock_at, sold_out_by_stock, available_days, available_from, available_to";

/** Thrown when a request needs 0062 and this database doesn't have it yet. */
export class MenuNeedsMigrationError extends Error {
  constructor() {
    super("needs_migration");
  }
}

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
  stock_qty?: number | null;
  low_stock_at?: number | null;
  sold_out_by_stock?: boolean;
  available_days?: number[] | null;
  available_from?: string | null;
  available_to?: string | null;
}

export type { VendorMenuAddonGroup, VendorMenuVariant } from "@/lib/data-access/menu-options";

export type VendorMenuItem = MenuItem & {
  dbId: string;
  externalId: string | null;
  sortOrder: number;
  createdAt: string | null;
  /** Units sold (non-cancelled orders). */
  soldCount: number;
  /** Revenue from those sales (rupees). */
  soldRevenue: number;
  /** 0062 fields; null/false/[] on a database without it. */
  stockQty: number | null;
  lowStockAt: number | null;
  soldOutByStock: boolean;
  availableDays: number[] | null;
  availableFrom: string | null;
  availableTo: string | null;
  variants: VendorMenuVariant[];
  addonGroups: VendorMenuAddonGroup[];
  /** 0146 moderation, so the shop sees why a dish is not on sale; defaults before 0146. */
  approvalStatus: "approved" | "pending" | "rejected";
  /** A price change waiting for Deligro's approval (the old price stays live). */
  pendingPrice: number | null;
  hidden: boolean;
  hiddenReason: string | null;
  approvalNote: string | null;
};

const MODERATION_COLUMN = "menu_items.approval_status";
type ModerationRow = {
  id: string;
  approval_status: VendorMenuItem["approvalStatus"];
  pending_price: number | null;
  hidden_by_ops: boolean;
  hidden_reason: string | null;
  approval_note: string | null;
};

/** Each dish's moderation state (0146), or an empty map on a database without it. */
async function loadModeration(ids: string[]): Promise<Map<string, ModerationRow>> {
  const out = new Map<string, ModerationRow>();
  if (ids.length === 0 || columnKnownMissing(MODERATION_COLUMN)) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .select("id, approval_status, pending_price, hidden_by_ops, hidden_reason, approval_note")
    .in("id", ids);
  if (error) {
    if (isMissingColumn(error)) rememberColumn(MODERATION_COLUMN, false);
    return out;
  }
  rememberColumn(MODERATION_COLUMN, true);
  for (const r of (data ?? []) as ModerationRow[]) out.set(r.id, r);
  return out;
}

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
  /** 0062: units left (null = untracked) and the level that alerts. */
  stockQty?: number | null;
  lowStockAt?: number | null;
  /** 0062: IST weekdays offered (0 = Sunday; null = every day) and a "HH:MM" window. */
  availableDays?: number[] | null;
  availableFrom?: string | null;
  availableTo?: string | null;
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

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);

function mapMenuItem(
  row: DbMenuItem,
  sales?: { soldCount: number; soldRevenue: number },
  options?: { variants: VendorMenuVariant[]; addonGroups: VendorMenuAddonGroup[] }
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
    stockQty: row.stock_qty ?? null,
    lowStockAt: row.low_stock_at ?? null,
    soldOutByStock: row.sold_out_by_stock ?? false,
    availableDays: row.available_days ?? null,
    availableFrom: hhmm(row.available_from),
    availableTo: hhmm(row.available_to),
    variants: options?.variants ?? [],
    addonGroups: options?.addonGroups ?? [],
    // 0146 moderation; listOwnedMenuItems fills the real values.
    approvalStatus: "approved",
    pendingPrice: null,
    hidden: false,
    hiddenReason: null,
    approvalNote: null,
  };
}

/** The 0062 fields an input carries, as columns. Empty when it carries none. */
function inventoryColumns(input: Partial<MenuItemInput>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.stockQty !== undefined) patch.stock_qty = input.stockQty;
  if (input.lowStockAt !== undefined) patch.low_stock_at = input.lowStockAt;
  if (input.availableDays !== undefined) patch.available_days = input.availableDays;
  if (input.availableFrom !== undefined) patch.available_from = input.availableFrom;
  if (input.availableTo !== undefined) patch.available_to = input.availableTo;
  return patch;
}

/**
 * Writes that name a 0062 column fail with 42703 before it is applied; say so
 * plainly instead of a 500, and remember it so reads stop asking.
 */
function rethrowMenuError(error: { code?: string; message?: string }, touchedInventory: boolean): never {
  if (touchedInventory && isMissingColumn(error)) {
    rememberColumn(INVENTORY_COLUMN, false);
    throw new MenuNeedsMigrationError();
  }
  throw error;
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
  return { ...row, ...inventoryColumns(input) };
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
  const base =
    "id, external_id, name, description, price, veg, available, category, image_url, popular, bestseller, sort_order, created_at";
  const select = (cols: string) =>
    supabase
      .from("menu_items")
      .select(cols)
      .eq("restaurant_id", restaurant.id)
      .order("sort_order", { ascending: true })
      .order("category", { ascending: true })
      .order("name", { ascending: true })
      .overrideTypes<DbMenuItem[]>();

  let primary = columnKnownMissing(INVENTORY_COLUMN)
    ? await select(base)
    : await select(base + INVENTORY_SELECT);
  if (primary.error && isMissingColumn(primary.error) && !columnKnownMissing(INVENTORY_COLUMN)) {
    rememberColumn(INVENTORY_COLUMN, false);
    primary = await select(base);
  } else if (!primary.error && !columnKnownMissing(INVENTORY_COLUMN)) {
    rememberColumn(INVENTORY_COLUMN, true);
  }

  let data: DbMenuItem[];
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
    data = primary.data ?? [];
  }

  const [salesByItem, optionsByItem, moderationByItem] = await Promise.all([
    loadMenuItemSales(restaurant.id),
    loadMenuOptions(data.map((row) => row.id)),
    loadModeration(data.map((row) => row.id)),
  ]);
  const items = data.map((row) => {
    const m = moderationByItem.get(row.id);
    return {
      ...mapMenuItem(row, salesByItem.get(row.id), optionsByItem.get(row.id)),
      approvalStatus: m?.approval_status ?? "approved",
      pendingPrice: m?.pending_price ?? null,
      hidden: m?.hidden_by_ops ?? false,
      hiddenReason: m?.hidden_reason ?? null,
      approvalNote: m?.approval_note ?? null,
    };
  });
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

  if (error) rethrowMenuError(error, Object.keys(inventoryColumns(input)).length > 0);
  return data?.id ?? null;
}

/** The text and price fields an edit touches, trimmed and checked. */
function editedDetails(input: Partial<MenuItemInput>): Record<string, unknown> {
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
  if (input.imageUrl !== undefined)
    patch.image_url = input.imageUrl.trim() || null;
  if (input.externalId !== undefined)
    patch.external_id = input.externalId?.trim() || null;
  return patch;
}

/** The on/off switches and position an edit touches, passed through as given. */
function editedFlags(input: Partial<MenuItemInput>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.veg !== undefined) patch.veg = input.veg;
  if (input.available !== undefined) patch.available = input.available;
  if (input.popular !== undefined) patch.popular = input.popular;
  if (input.bestseller !== undefined) patch.bestseller = input.bestseller;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
  return patch;
}

export async function updateMenuItem(
  menuItemId: string,
  input: Partial<MenuItemInput>
): Promise<boolean> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return false;

  const inventory = inventoryColumns(input);
  const patch = { ...editedDetails(input), ...editedFlags(input), ...inventory };

  if (Object.keys(patch).length === 0) return false;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("menu_items")
    .update(patch)
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurant.id)
    .select("id")
    .maybeSingle();

  if (error) rethrowMenuError(error, Object.keys(inventory).length > 0);
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

/** This shop's items carrying any of `externalIds`, keyed by that id. */
async function itemIdsByExternalId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  restaurantId: string,
  externalIds: string[]
): Promise<{ ids: Map<string, string>; error: string | null }> {
  const ids = new Map<string, string>();
  const { data: existing, error } = await supabase
    .from("menu_items")
    .select("id, external_id")
    .eq("restaurant_id", restaurantId)
    .in("external_id", externalIds);
  if (error) return { ids, error: error.message };
  for (const row of existing ?? []) {
    if (row.external_id) ids.set(row.external_id, row.id);
  }
  return { ids, error: null };
}

/** One import row as menu_items columns, or the reason it was skipped. */
function parseImportRow(
  r: MenuImportRow
):
  | { skipped: string }
  | { externalId: string | null; base: Record<string, unknown> } {
  const name = r.name?.trim() ?? "";
  const price = Math.round(Number(r.price));
  if (!name) return { skipped: "Row skipped: name is required" };
  if (!Number.isFinite(price) || price < 0) {
    return { skipped: `Row skipped (${name}): invalid price` };
  }

  return {
    externalId: r.externalId?.trim() || null,
    base: {
      name,
      category: r.category?.trim() || "Popular",
      price,
      description: r.description?.trim() || null,
      veg: r.veg ?? true,
      available: r.available ?? true,
      popular: r.popular ?? false,
      bestseller: r.bestseller ?? false,
      image_url: r.imageUrl?.trim() || null,
    },
  };
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

  let existingByExternal = new Map<string, string>();
  if (externalIds.length > 0) {
    const existing = await itemIdsByExternalId(supabase, restaurant.id, externalIds);
    if (existing.error !== null) {
      return {
        created: 0,
        updated: 0,
        failed: capped.length,
        errors: [existing.error],
      };
    }
    existingByExternal = existing.ids;
  }

  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];

  capped.forEach((r) => {
    const parsed = parseImportRow(r);
    if ("skipped" in parsed) {
      failed += 1;
      errors.push(parsed.skipped);
      return;
    }
    const { externalId, base } = parsed;

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
  const copyId = data?.id ?? null;
  if (copyId) await copyInventoryAndOptions(menuItemId, copyId);
  return copyId;
}

/**
 * A duplicate keeps the dish's schedule, low-stock level and options (0062),
 * but not its stock count: the copy is a new dish with nothing counted yet.
 * A no-op on a database without 0062.
 */
async function copyInventoryAndOptions(sourceId: string, copyId: string): Promise<void> {
  if (columnKnownMissing(INVENTORY_COLUMN)) return;
  const supabase = await createClient();
  const { data: src, error } = await supabase
    .from("menu_items")
    .select("low_stock_at, available_days, available_from, available_to")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(INVENTORY_COLUMN, false);
      return;
    }
    throw error;
  }
  if (src) {
    const { error: upd } = await supabase.from("menu_items").update(src).eq("id", copyId);
    if (upd) throw upd;
  }
  const options = (await loadMenuOptions([sourceId])).get(sourceId);
  if (options && (options.variants.length > 0 || options.addonGroups.length > 0)) {
    const fresh = ({ name, price, available }: VendorMenuVariant) => ({ name, price, available });
    await replaceMenuOptions(copyId, {
      variants: options.variants.map(fresh),
      addonGroups: options.addonGroups.map((g) => ({
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        addons: g.addons.map(fresh),
      })),
    });
  }
}

type Supa = Awaited<ReturnType<typeof createClient>>;

/**
 * Keep the rows whose ids came back, insert the new ones, delete the rest.
 * Ids the request names that this parent doesn't have are treated as new,
 * so a client can never move another dish's option onto this one. Kept ids
 * matter: a customer's cart holds variant and add-on ids, and re-creating
 * every row on each save would empty it.
 */
async function syncRows<T extends { id?: string }>(
  supabase: Supa,
  table: "menu_item_variants" | "menu_item_addon_groups" | "menu_item_addons",
  parent: { column: "menu_item_id" | "group_id"; id: string },
  rows: T[],
  toColumns: (row: T, index: number) => Record<string, unknown>
): Promise<string[]> {
  const { data: existing, error } = await supabase.from(table).select("id").eq(parent.column, parent.id);
  if (error) throw error;
  const have = new Set((existing ?? []).map((r) => r.id as string));
  const keep = new Set(rows.map((r) => r.id).filter((id): id is string => Boolean(id && have.has(id))));

  const gone = [...have].filter((id) => !keep.has(id));
  if (gone.length > 0) {
    const { error: del } = await supabase.from(table).delete().in("id", gone);
    if (del) throw del;
  }

  const ids: string[] = [];
  for (const [index, row] of rows.entries()) {
    const cols = { ...toColumns(row, index), sort_order: index };
    if (row.id && keep.has(row.id)) {
      const { error: upd } = await supabase.from(table).update(cols).eq("id", row.id).eq(parent.column, parent.id);
      if (upd) throw upd;
      ids.push(row.id);
    } else {
      const { data, error: ins } = await supabase
        .from(table)
        .insert({ ...cols, [parent.column]: parent.id })
        .select("id")
        .single();
      if (ins) throw ins;
      ids.push(data.id as string);
    }
  }
  return ids;
}

/**
 * Replace a dish's variants and add-on groups with `input` (already checked
 * by parseMenuOptions). False when the dish isn't the active shop's. RLS
 * checks the owner on every row underneath.
 */
export async function replaceMenuOptions(menuItemId: string, input: MenuOptionsInput): Promise<boolean> {
  const restaurant = await requireOwnedRestaurant();
  if (!restaurant) return false;
  if (columnKnownMissing(INVENTORY_COLUMN)) throw new MenuNeedsMigrationError();

  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("menu_items")
    .select("id")
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  if (error) throw error;
  if (!item) return false;

  try {
    await syncRows(supabase, "menu_item_variants", { column: "menu_item_id", id: menuItemId }, input.variants, (v) => ({
      name: v.name,
      price: v.price,
      available: v.available,
    }));
    const groupIds = await syncRows(
      supabase,
      "menu_item_addon_groups",
      { column: "menu_item_id", id: menuItemId },
      input.addonGroups,
      (g) => ({ name: g.name, min_select: g.minSelect, max_select: g.maxSelect })
    );
    for (const [i, g] of input.addonGroups.entries()) {
      await syncRows(supabase, "menu_item_addons", { column: "group_id", id: groupIds[i] }, g.addons, (a) => ({
        name: a.name,
        price: a.price,
        available: a.available,
      }));
    }
  } catch (e) {
    if (isMissingTable(e as { code?: string })) {
      rememberColumn(INVENTORY_COLUMN, false);
      throw new MenuNeedsMigrationError();
    }
    throw e;
  }
  return true;
}

/** False once a read has found this database without 0062. */
export function menuInventorySupported(): boolean {
  return !columnKnownMissing(INVENTORY_COLUMN);
}
