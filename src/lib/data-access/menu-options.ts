import "server-only";
import { createClient } from "@/lib/supabase/server";
import { columnKnownMissing, isMissingTable } from "@/lib/data-access/schema-probe";

/**
 * Dish sizes and add-on groups (migration 0062), for the vendor's menu and
 * the customer's storefront alike. Readable like the menu itself: an approved
 * shop's options by anyone, an unapproved shop's by its owner (RLS).
 */

/** Probe key for 0062's menu columns (stock, schedule) and option tables. */
export const INVENTORY_COLUMN = "menu_items.stock_qty";

export interface VendorMenuVariant {
  id: string;
  name: string;
  price: number;
  available: boolean;
}

export interface VendorMenuAddonGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  addons: VendorMenuVariant[];
}

export type ItemOptions = { variants: VendorMenuVariant[]; addonGroups: VendorMenuAddonGroup[] };

/**
 * Variants and add-on groups (0062) for these dishes, keyed by dish id.
 * Empty on a database without the tables, so the menu still loads.
 */
export async function loadMenuOptions(itemIds: string[]): Promise<Map<string, ItemOptions>> {
  const map = new Map<string, ItemOptions>();
  if (itemIds.length === 0 || columnKnownMissing(INVENTORY_COLUMN)) return map;
  const supabase = await createClient();
  const entry = (id: string) => {
    let e = map.get(id);
    if (!e) map.set(id, (e = { variants: [], addonGroups: [] }));
    return e;
  };

  // Chunked: a big menu's ids would overflow the request URL.
  for (let i = 0; i < itemIds.length; i += 150) {
    const ids = itemIds.slice(i, i + 150);
    const [variants, groups] = await Promise.all([
      supabase
        .from("menu_item_variants")
        .select("id, menu_item_id, name, price, available")
        .in("menu_item_id", ids)
        .order("sort_order")
        .order("created_at"),
      supabase
        .from("menu_item_addon_groups")
        .select("id, menu_item_id, name, min_select, max_select, menu_item_addons(id, name, price, available, sort_order, created_at)")
        .in("menu_item_id", ids)
        .order("sort_order")
        .order("created_at"),
    ]);
    if (variants.error || groups.error) {
      if (isMissingTable(variants.error) || isMissingTable(groups.error)) return map;
      throw variants.error ?? groups.error;
    }
    for (const v of variants.data ?? []) {
      entry(v.menu_item_id).variants.push({ id: v.id, name: v.name, price: v.price, available: v.available });
    }
    for (const g of groups.data ?? []) {
      const addons = [...((g.menu_item_addons ?? []) as { id: string; name: string; price: number; available: boolean; sort_order: number; created_at: string }[])]
        .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
        .map((a) => ({ id: a.id, name: a.name, price: a.price, available: a.available }));
      entry(g.menu_item_id).addonGroups.push({
        id: g.id,
        name: g.name,
        minSelect: g.min_select,
        maxSelect: g.max_select,
        addons,
      });
    }
  }
  return map;
}
