import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { autoMatchImage } from "@/lib/data-access/food-images";
import { opsProductAction } from "@/lib/data-access/manager-product-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { scopeAllows, type ManagerScope } from "@/lib/auth/manager-scope";
import {
  gridToCsv,
  gridToXlsx,
  parseSheetFile,
  templateGrid,
  EXAMPLE_ITEMS,
  type ColumnKey,
  type TemplateItem,
} from "@/lib/bulk/menu-sheet";
import type { BulkOutcome } from "@/lib/bulk/outcome";
import {
  MANAGER_COLUMNS,
  OWNER_COLUMNS,
  planSheet,
  type ExistingDish,
  type Plan,
} from "@/lib/bulk/menu-plan";

/**
 * Bulk menu and inventory upload, for the shop owner (Partner app, vendor site),
 * the admin console and — stock only — the manager.
 *
 * Preview and apply are the same call with a different `mode`: the file is read
 * and planned afresh each time, so what is written is exactly what the person
 * just saw, against the menu as it is now, and nothing has to be kept between
 * the two requests.
 */

const BASE_COLUMNS = "id, external_id, name, category, price, discount_price, description, veg, available, popular, bestseller, image_url";
const STOCK_COLUMNS = ", stock_qty, low_stock_at";
const PAGE = 5000;

type Db = SupabaseClient;

interface DishRow {
  id: string;
  external_id: string | null;
  name: string;
  category: string | null;
  price: number;
  discount_price: number | null;
  description: string | null;
  veg: boolean;
  available: boolean;
  popular: boolean | null;
  bestseller: boolean | null;
  image_url: string | null;
  stock_qty?: number | null;
  low_stock_at?: number | null;
}

function dishOf(r: DishRow): ExistingDish {
  return {
    id: r.id,
    externalId: r.external_id,
    name: r.name,
    category: r.category,
    price: r.price,
    discountPrice: r.discount_price,
    description: r.description,
    veg: r.veg,
    available: r.available,
    popular: r.popular === true,
    bestseller: r.bestseller === true,
    imageUrl: r.image_url,
    stockQty: r.stock_qty ?? null,
    lowStockAt: r.low_stock_at ?? null,
  };
}

/** The shop's dishes, and whether the database has the stock columns (0062). */
export async function loadDishes(db: Db, restaurantId: string): Promise<{ dishes: ExistingDish[]; hasInventory: boolean }> {
  const read = (columns: string) =>
    db.from("menu_items").select(columns).eq("restaurant_id", restaurantId).order("category").order("name").range(0, PAGE - 1);

  let hasInventory = true;
  let res = await read(BASE_COLUMNS + STOCK_COLUMNS);
  if (res.error) {
    // 42703: the database predates 0062, so there is no stock to read or write.
    if (res.error.code !== "42703") throw new Error("load_failed");
    hasInventory = false;
    res = await read(BASE_COLUMNS);
    if (res.error) throw new Error("load_failed");
  }
  return { dishes: ((res.data ?? []) as unknown as DishRow[]).map(dishOf), hasInventory };
}

export type { BulkItemOut, BulkOutcome } from "@/lib/bulk/outcome";

const SHOWN = 300;

function outcome(mode: "preview" | "apply", plan: Plan, parsed: ReturnType<typeof parseSheetFile>): BulkOutcome {
  const items = plan.items.slice(0, SHOWN).map(({ line, action, name, changes, message }) => ({ line, action, name, changes, ...(message ? { message } : {}) }));
  return {
    mode,
    counts: plan.counts,
    items,
    moreItems: Math.max(0, plan.items.length - items.length),
    issues: parsed.issues,
    columns: parsed.columns,
    unknownColumns: parsed.unknownColumns,
    ignoredColumns: plan.ignoredColumns,
  };
}

async function inBatches<T>(list: T[], size: number, each: (item: T) => Promise<void>) {
  for (let i = 0; i < list.length; i += size) await Promise.all(list.slice(i, i + size).map(each));
}

/**
 * The owner's (or an admin's) sheet: adds new dishes and changes existing ones.
 * `db` must be a client that may write this shop's menu (the owner's session, or
 * an admin's); row-level security still applies, and so do the menu triggers
 * (a price change on a restricted category waits for approval, as it does by hand).
 */
export async function runOwnerSheet(args: {
  db: Db;
  restaurantId: string;
  bytes: Uint8Array;
  filename: string;
  mode: "preview" | "apply";
}): Promise<BulkOutcome> {
  const parsed = parseSheetFile(args.bytes, args.filename);
  const { dishes, hasInventory } = await loadDishes(args.db, args.restaurantId);
  const plan = planSheet(dishes, parsed.rows, { canCreate: true, allowed: OWNER_COLUMNS, hasInventory, sheetColumns: parsed.columns });
  const out = outcome(args.mode, plan, parsed);
  if (args.mode === "preview") return out;

  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  await inBatches(plan.items.filter((i) => i.action === "update"), 8, async (item) => {
    const { error } = await args.db.from("menu_items").update(item.patch!).eq("id", item.dishId!).eq("restaurant_id", args.restaurantId);
    if (error) {
      failed += 1;
      errors.push(`Row ${item.line} (${item.name}): could not be saved.`);
    } else {
      updated += 1;
    }
  });

  const inserts = plan.items.filter((i) => i.action === "create");
  // A new dish with no photo of its own gets the photo library's match when the
  // name leaves no doubt (autoMatchImage returns nothing when it is ambiguous).
  await inBatches(inserts.filter((c) => !c.insert!.image_url), 8, async (item) => {
    try {
      const match = await autoMatchImage(String(item.insert!.name));
      if (match) Object.assign(item.insert!, { image_url: match.image.imageUrl, image_library_id: match.image.id });
    } catch {
      // The library is a convenience: the dish still saves without a photo.
    }
  });
  for (let i = 0; i < inserts.length; i += 100) {
    const chunk = inserts.slice(i, i + 100);
    const rows: Record<string, unknown>[] = chunk.map((c) => ({ restaurant_id: args.restaurantId, ...c.insert! }));
    let { data, error } = await args.db.from("menu_items").insert(rows).select("id");
    if (error && error.code === "42703") {
      // A database that predates 0035 has no image_library_id; the photo still lands without the note of where it came from.
      ({ data, error } = await args.db.from("menu_items").insert(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "image_library_id")))).select("id"));
    }
    if (error) {
      failed += chunk.length;
      errors.push(`Rows ${chunk[0].line}–${chunk[chunk.length - 1].line}: new dishes could not be saved.`);
    } else {
      created += data?.length ?? 0;
    }
  }
  // Rows that could not be planned count as failed too, so the total adds up.
  failed += plan.counts.error;
  return { ...out, applied: { created, updated, failed, errors: errors.slice(0, 20) } };
}

/** A shop's menu as a sheet the owner can edit and send back (or an empty template). */
export async function exportOwnerSheet(db: Db, restaurantId: string, format: "csv" | "xlsx", template: boolean): Promise<{ body: Uint8Array | string; contentType: string; filename: string }> {
  const { dishes, hasInventory } = template ? { dishes: [], hasInventory: true } : await loadDishes(db, restaurantId);
  const items: TemplateItem[] = template || dishes.length === 0 ? EXAMPLE_ITEMS : dishes.map(toTemplateItem);
  const columns = TEMPLATE_KEYS.filter((k) => hasInventory || (k !== "stock" && k !== "lowStockAt"));
  return fileOf(templateGrid(items, columns), format, template || dishes.length === 0 ? "menu-template" : "menu");
}

const TEMPLATE_KEYS: ColumnKey[] = ["id", "name", "category", "price", "discountPrice", "description", "veg", "available", "popular", "bestseller", "imageUrl", "stock", "lowStockAt"];

function toTemplateItem(d: ExistingDish): TemplateItem {
  return {
    id: d.externalId ?? d.id,
    name: d.name,
    category: d.category,
    price: d.price,
    discountPrice: d.discountPrice,
    description: d.description,
    veg: d.veg,
    available: d.available,
    popular: d.popular,
    bestseller: d.bestseller,
    imageUrl: d.imageUrl,
    stock: d.stockQty,
    lowStockAt: d.lowStockAt,
  };
}

function fileOf(grid: (string | number)[][], format: "csv" | "xlsx", base: string) {
  return format === "xlsx"
    ? { body: gridToXlsx(grid), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${base}.xlsx` }
    : { body: gridToCsv(grid), contentType: "text/csv; charset=utf-8", filename: `${base}.csv` };
}

// ── manager: stock only ──────────────────────────────────────────────────────

export const MANAGER_SHEET_ROWS = 200;

/** The shop, if it is one of the manager's (by zone). Null otherwise: a 404, never a hint it exists. */
export async function managerShop(scope: ManagerScope, restaurantId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await createAdminClient().from("restaurants").select("id, name, zone_id").eq("id", restaurantId).maybeSingle();
  const row = data as { id: string; name: string; zone_id: string | null } | null;
  return row && scopeAllows(scope, row.zone_id) ? { id: row.id, name: row.name } : null;
}

/**
 * A manager's stock sheet. Only the count of each dish can change, and each
 * change goes through the same audited step as the stock button on the product
 * screen (ops_adjust_stock), with the count the sheet was made from as its
 * "expected" value: a dish an order or the vendor moved since is refused, not
 * overwritten.
 */
export async function runManagerStockSheet(args: {
  actor: OpsActor;
  scope: ManagerScope;
  restaurantId: string;
  bytes: Uint8Array;
  filename: string;
  mode: "preview" | "apply";
  canAdjust: boolean;
}): Promise<BulkOutcome> {
  const parsed = parseSheetFile(args.bytes, args.filename);
  const db = createAdminClient();
  const { dishes, hasInventory } = await loadDishes(db, args.restaurantId);
  const capped = parsed.rows.slice(0, MANAGER_SHEET_ROWS);
  const issues = [...parsed.issues];
  if (parsed.rows.length > MANAGER_SHEET_ROWS) issues.push({ line: 0, message: `A manager's sheet is limited to ${MANAGER_SHEET_ROWS} dishes; the rest were ignored.` });
  const plan = planSheet(dishes, capped, { canCreate: false, allowed: MANAGER_COLUMNS, hasInventory, sheetColumns: parsed.columns });
  const out = { ...outcome(args.mode, plan, { ...parsed, issues }), issues };
  if (args.mode === "preview") return out;
  if (!args.canAdjust) throw new Error("permission_denied");

  let updated = 0;
  let failed = plan.counts.error;
  const errors: string[] = [];
  const todo = plan.items.filter((i) => i.action === "update" && i.patch && "stock_qty" in i.patch);
  await inBatches(todo, 5, async (item) => {
    try {
      const result = await opsProductAction(args.actor, args.scope, item.dishId!, {
        action: "adjust_stock",
        stockQty: item.patch!.stock_qty as number | null,
        expectedStockQty: item.stockBefore ?? null,
        reason: "Bulk stock update from a sheet",
        clientActionId: randomUUID(),
      });
      if (result.ok) {
        updated += 1;
      } else {
        failed += 1;
        errors.push(`Row ${item.line} (${item.name}): ${result.error === "stale" ? "the count changed since the sheet was made." : "could not be changed."}`);
      }
    } catch {
      failed += 1;
      errors.push(`Row ${item.line} (${item.name}): could not be changed.`);
    }
  });
  return { ...out, applied: { created: 0, updated, failed, errors: errors.slice(0, 20) } };
}

/** The manager's stock sheet to fill in: id, name, category and the current count. */
export async function exportManagerSheet(restaurantId: string, format: "csv" | "xlsx"): Promise<{ body: Uint8Array | string; contentType: string; filename: string }> {
  const { dishes } = await loadDishes(createAdminClient(), restaurantId);
  const items = dishes.map(toTemplateItem);
  return fileOf(templateGrid(items, ["id", "name", "category", "stock"]), format, "stock");
}
