/**
 * What a parsed sheet WOULD do to a shop's menu, worked out against the dishes
 * the shop already has. Pure (no database), so the same plan backs the preview
 * the person confirms and the write that follows it, and so it can be tested.
 *
 * A row finds its dish by `id` (the dish's own id, or the shop's code for it),
 * else by name (and category, when the sheet has one). No match means a new
 * dish, if the caller may create. Only fields the sheet carries are touched,
 * and a field already equal is not a change, so re-uploading a sheet is safe.
 */
import type { ColumnKey, SheetRow } from "@/lib/bulk/menu-sheet";

export interface ExistingDish {
  id: string;
  externalId: string | null;
  name: string;
  category: string | null;
  price: number;
  discountPrice: number | null;
  description: string | null;
  veg: boolean;
  available: boolean;
  popular: boolean;
  bestseller: boolean;
  imageUrl: string | null;
  stockQty: number | null;
  lowStockAt: number | null;
}

export type PlanAction = "create" | "update" | "unchanged" | "error";

export interface PlanItem {
  line: number;
  action: PlanAction;
  name: string;
  /** Plain-language list of what changes ("price 220 → 249"). */
  changes: string[];
  message?: string;
  /** update: the dish's id, and the columns to write. */
  dishId?: string;
  patch?: Record<string, unknown>;
  /** update: the stock the sheet's author saw, for the manager's stale check. */
  stockBefore?: number | null;
  /** create: the columns of the new dish (restaurant_id is added by the writer). */
  insert?: Record<string, unknown>;
}

export interface PlanCounts {
  create: number;
  update: number;
  unchanged: number;
  error: number;
}

export interface Plan {
  items: PlanItem[];
  counts: PlanCounts;
  /** Columns of the sheet that this caller may not set, so were left out. */
  ignoredColumns: ColumnKey[];
}

export interface PlanOptions {
  canCreate: boolean;
  /** Columns the caller may set. Anything else in the sheet is ignored. */
  allowed: ReadonlySet<ColumnKey>;
  /** False on a database without stock columns (0062). */
  hasInventory: boolean;
  /** The columns the sheet carries (from the parser). */
  sheetColumns: readonly ColumnKey[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CATEGORY = "Popular";

const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function describe(label: string, from: unknown, to: unknown): string {
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  return `${label} ${show(from)} → ${show(to)}`;
}

export function planSheet(existing: ExistingDish[], rows: SheetRow[], opts: PlanOptions): Plan {
  const byId = new Map<string, ExistingDish>();
  const byCode = new Map<string, ExistingDish>();
  const byName = new Map<string, ExistingDish[]>();
  for (const d of existing) {
    byId.set(d.id.toLowerCase(), d);
    if (d.externalId) byCode.set(key(d.externalId), d);
    const list = byName.get(key(d.name)) ?? [];
    list.push(d);
    byName.set(key(d.name), list);
  }

  const ignoredColumns = opts.sheetColumns.filter((c) => c !== "id" && c !== "name" && !opts.allowed.has(c));
  const allowed = (c: ColumnKey) => opts.allowed.has(c);
  const items: PlanItem[] = [];
  const claimed = new Set<string>();

  for (const row of rows) {
    const label = row.name ?? row.id ?? `row ${row.line}`;
    const err = (message: string): PlanItem => ({ line: row.line, action: "error", name: label, changes: [], message });

    if ((row.stock !== undefined || row.lowStockAt !== undefined) && allowed("stock") && !opts.hasInventory) {
      items.push(err("Stock tracking is not available yet for this shop."));
      continue;
    }

    // --- find the dish ---
    let match: ExistingDish | undefined;
    let wantsCode: string | null = null;
    if (row.id) {
      match = byId.get(row.id.toLowerCase()) ?? byCode.get(key(row.id));
      if (!match) {
        if (UUID.test(row.id)) {
          items.push(err(`No dish has the id ${row.id}.`));
          continue;
        }
        wantsCode = row.id;
      }
    }
    if (!match && !row.id && row.name) {
      const sameName = byName.get(key(row.name)) ?? [];
      const wanted = row.category ? sameName.filter((d) => key(d.category ?? DEFAULT_CATEGORY) === key(row.category)) : sameName;
      if (wanted.length > 1) {
        items.push(err("More than one dish has this name. Add the id or the category."));
        continue;
      }
      match = wanted[0];
    }
    if (match && claimed.has(match.id)) {
      items.push(err("Another row already changes this dish."));
      continue;
    }

    // --- update ---
    if (match) {
      claimed.add(match.id);
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const set = (col: ColumnKey, column: string, label: string, from: unknown, to: unknown) => {
        if (!allowed(col) || to === undefined || from === to) return;
        patch[column] = to;
        changes.push(describe(label, from, to));
      };
      // Renaming by id, when the caller may.
      if (row.name !== undefined && row.id) set("name", "name", "name", match.name, row.name);
      if (row.category !== undefined) set("category", "category", "category", match.category ?? DEFAULT_CATEGORY, row.category);
      set("price", "price", "price", match.price, row.price);
      set("discountPrice", "discount_price", "discount", match.discountPrice, row.discountPrice);
      set("description", "description", "description", match.description, row.description);
      set("veg", "veg", "veg", match.veg, row.veg);
      set("available", "available", "available", match.available, row.available);
      set("popular", "popular", "popular", match.popular, row.popular);
      set("bestseller", "bestseller", "bestseller", match.bestseller, row.bestseller);
      set("imageUrl", "image_url", "photo", match.imageUrl, row.imageUrl);
      if (opts.hasInventory) {
        set("stock", "stock_qty", "stock", match.stockQty, row.stock);
        set("lowStockAt", "low_stock_at", "low-stock alert", match.lowStockAt, row.lowStockAt);
      }
      if (allowed("id") && row.id && match.externalId !== row.id && !UUID.test(row.id)) {
        patch.external_id = row.id;
        changes.push(describe("code", match.externalId, row.id));
      }

      const price = (patch.price as number | undefined) ?? match.price;
      const discount = "discount_price" in patch ? (patch.discount_price as number | null) : match.discountPrice;
      if (discount != null && discount >= price) {
        items.push({ ...err("The discount price must be lower than the price."), dishId: match.id });
        continue;
      }
      items.push(
        changes.length === 0
          ? { line: row.line, action: "unchanged", name: match.name, changes: [], dishId: match.id }
          : { line: row.line, action: "update", name: match.name, changes, dishId: match.id, patch, stockBefore: match.stockQty },
      );
      continue;
    }

    // --- create ---
    if (!opts.canCreate) {
      items.push(err("No dish matches this row, and new dishes can't be added here."));
      continue;
    }
    if (!row.name) {
      items.push(err("A new dish needs a name."));
      continue;
    }
    if (row.price === undefined) {
      items.push(err("A new dish needs a price."));
      continue;
    }
    if (row.discountPrice != null && row.discountPrice >= row.price) {
      items.push(err("The discount price must be lower than the price."));
      continue;
    }
    const insert: Record<string, unknown> = {
      name: row.name,
      category: row.category ?? DEFAULT_CATEGORY,
      price: row.price,
      discount_price: row.discountPrice ?? null,
      description: row.description ?? null,
      veg: row.veg ?? true,
      available: row.available ?? true,
      popular: row.popular ?? false,
      bestseller: row.bestseller ?? false,
      image_url: row.imageUrl ?? null,
      external_id: wantsCode,
    };
    if (opts.hasInventory) {
      if (row.stock !== undefined) insert.stock_qty = row.stock;
      if (row.lowStockAt !== undefined) insert.low_stock_at = row.lowStockAt;
    }
    items.push({ line: row.line, action: "create", name: row.name, changes: [`new dish at ₹${row.price}`], insert });
  }

  const counts: PlanCounts = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const i of items) counts[i.action] += 1;
  return { items, counts, ignoredColumns };
}

/** Columns each kind of caller may set. */
export const OWNER_COLUMNS: ReadonlySet<ColumnKey> = new Set<ColumnKey>([
  "id", "name", "category", "price", "discountPrice", "description", "veg", "available", "popular", "bestseller", "imageUrl", "stock", "lowStockAt",
]);

/** A manager adjusts counts, nothing else (the same limit as the product screen). */
export const MANAGER_COLUMNS: ReadonlySet<ColumnKey> = new Set<ColumnKey>(["id", "name", "category", "stock"]);
