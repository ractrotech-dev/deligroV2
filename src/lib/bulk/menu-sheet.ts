/**
 * Reading a menu / inventory sheet (CSV or Excel) into rows, with no database
 * and no server-only import so scripts/qa can run it. One reader for every
 * place a sheet comes in: the Partner app, the manager app, the vendor and
 * admin websites.
 *
 * Two rules keep a re-upload from doing damage:
 *
 *  - Only the columns the sheet HAS are applied. A sheet with just `id,stock`
 *    changes stock and nothing else; it can never blank a price it did not
 *    mention. A field a row leaves empty is "leave as is", not "clear".
 *  - To clear a value on purpose, write `none` (stock: `untracked`).
 *
 * Header names are forgiving ("Veg (Yes/No)", "Discount Price", "Stock Qty").
 */
import * as XLSX from "xlsx";
import { removeParentheticals, trimEdges } from "@/lib/utils/text-shape";

export const MAX_SHEET_ROWS = 500;
export const MAX_SHEET_BYTES = 2 * 1024 * 1024;

export type ColumnKey =
  | "id"
  | "name"
  | "category"
  | "price"
  | "discountPrice"
  | "description"
  | "veg"
  | "available"
  | "popular"
  | "bestseller"
  | "imageUrl"
  | "stock"
  | "lowStockAt";

/** Header (normalised) → column. */
const ALIASES: Record<string, ColumnKey> = {
  id: "id",
  external_id: "id",
  item_id: "id",
  code: "id",
  sku: "id",
  name: "name",
  item: "name",
  item_name: "name",
  dish: "name",
  product: "name",
  category: "category",
  price: "price",
  mrp: "price",
  rate: "price",
  discount_price: "discountPrice",
  sale_price: "discountPrice",
  offer_price: "discountPrice",
  description: "description",
  veg: "veg",
  is_veg: "veg",
  available: "available",
  is_available: "available",
  popular: "popular",
  bestseller: "bestseller",
  image_url: "imageUrl",
  image: "imageUrl",
  photo: "imageUrl",
  stock: "stock",
  stock_qty: "stock",
  quantity: "stock",
  qty: "stock",
  inventory: "stock",
  low_stock_at: "lowStockAt",
  low_stock: "lowStockAt",
  low_stock_level: "lowStockAt",
  reorder_level: "lowStockAt",
};

/** The columns of the template, in order, with the header each is written under. */
export const TEMPLATE_COLUMNS: { key: ColumnKey; header: string }[] = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "category", header: "category" },
  { key: "price", header: "price" },
  { key: "discountPrice", header: "discount_price" },
  { key: "description", header: "description" },
  { key: "veg", header: "veg" },
  { key: "available", header: "available" },
  { key: "popular", header: "popular" },
  { key: "bestseller", header: "bestseller" },
  { key: "imageUrl", header: "image_url" },
  { key: "stock", header: "stock" },
  { key: "lowStockAt", header: "low_stock_at" },
];

/** One row of the sheet. `undefined` = the sheet did not say; `null` = clear it. */
export interface SheetRow {
  /** The spreadsheet row number, header = 1. */
  line: number;
  id?: string;
  name?: string;
  category?: string;
  price?: number;
  discountPrice?: number | null;
  description?: string;
  veg?: boolean;
  available?: boolean;
  popular?: boolean;
  bestseller?: boolean;
  imageUrl?: string | null;
  stock?: number | null;
  lowStockAt?: number | null;
}

export interface RowIssue {
  /** 0 = about the file, not one row. */
  line: number;
  message: string;
}

export interface ParsedSheet {
  rows: SheetRow[];
  issues: RowIssue[];
  /** Columns the sheet has, recognised. */
  columns: ColumnKey[];
  /** Headers that were not recognised and are ignored. */
  unknownColumns: string[];
  truncated: boolean;
}

const EMPTY: ParsedSheet = { rows: [], issues: [], columns: [], unknownColumns: [], truncated: false };

function fail(message: string): ParsedSheet {
  return { ...EMPTY, issues: [{ line: 0, message }] };
}

function normaliseHeader(raw: string): string {
  return trimEdges(removeParentheticals(raw.toLowerCase()).replace(/[^a-z0-9]+/g, "_"), "_");
}

function cellText(v: unknown): string {
  // A leading apostrophe is the guard our own export puts before =, +, - and @.
  if (typeof v === "string") return v.trim().replace(/^'(?=[=+\-@])/, "");
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}

const CLEAR = /^(none|clear|null|-|na|n\/a|untracked)$/i;

/** A whole number >= 0, "" (leave) or null (clear). `undefined` result = invalid. */
function wholeNumber(text: string, max: number, roundRupees = false): number | null | "" | undefined {
  if (text === "") return "";
  if (CLEAR.test(text)) return null;
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (!(roundRupees ? /^\d+(\.\d+)?$/ : /^\d+(\.0+)?$/).test(cleaned)) return undefined;
  const n = roundRupees ? Math.round(Number(cleaned)) : Math.trunc(Number(cleaned));
  return n <= max ? n : undefined;
}

function yesNo(text: string): boolean | "" | undefined {
  if (text === "") return "";
  const v = text.toLowerCase();
  if (["1", "true", "yes", "y", "veg", "available", "on", "in stock"].includes(v)) return true;
  if (["0", "false", "no", "n", "non-veg", "nonveg", "non veg", "off", "sold out", "unavailable", "out of stock"].includes(v)) return false;
  return undefined;
}

function toGrid(bytes: Uint8Array, filename: string): unknown[][] | string {
  if (bytes.byteLength === 0) return "The file is empty.";
  if (bytes.byteLength > MAX_SHEET_BYTES) return "The file is larger than 2 MB.";
  let wb: XLSX.WorkBook;
  try {
    const text = /\.(xlsx|xlsm|xls)$/i.test(filename) ? null : new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    wb = text === null ? XLSX.read(bytes, { type: "array", cellDates: false }) : XLSX.read(text, { type: "string", cellDates: false });
  } catch {
    return "The file could not be read. Use the template: a .csv or .xlsx file.";
  }
  const sheet = wb.Sheets[wb.SheetNames[0] ?? ""];
  if (!sheet) return "The file has no sheet.";
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: false, raw: true });
}

/** Reads a CSV / Excel file's bytes. Never throws: problems come back as issues. */
export function parseSheetFile(bytes: Uint8Array, filename: string): ParsedSheet {
  const grid = toGrid(bytes, filename);
  if (typeof grid === "string") return fail(grid);
  if (grid.length === 0) return fail("The file is empty.");

  const headerCells = (grid[0] ?? []).map((h) => cellText(h));
  const colOf = new Map<ColumnKey, number>();
  const unknown: string[] = [];
  headerCells.forEach((h, i) => {
    if (!h) return;
    const key = ALIASES[normaliseHeader(h)];
    if (!key) unknown.push(h);
    else if (!colOf.has(key)) colOf.set(key, i);
  });

  const columns = [...colOf.keys()];
  if (!colOf.has("id") && !colOf.has("name")) {
    return { ...EMPTY, unknownColumns: unknown, issues: [{ line: 1, message: "The first row must name the columns. Include at least `id` or `name`." }] };
  }

  const issues: RowIssue[] = [];
  const rows: SheetRow[] = [];
  const dataRows = grid.slice(1);
  const truncated = dataRows.length > MAX_SHEET_ROWS;
  if (truncated) issues.push({ line: 0, message: `Only the first ${MAX_SHEET_ROWS} rows are read; the rest are ignored.` });

  const seenIds = new Set<string>();
  dataRows.slice(0, MAX_SHEET_ROWS).forEach((cells, idx) => {
    const line = idx + 2;
    const get = (key: ColumnKey) => {
      const i = colOf.get(key);
      return i === undefined ? undefined : cellText(cells[i]);
    };
    const row: SheetRow = { line };
    const problems: string[] = [];

    const id = get("id");
    if (id) {
      if (seenIds.has(id.toLowerCase())) problems.push(`id "${id}" appears twice in the sheet`);
      seenIds.add(id.toLowerCase());
      row.id = id;
    }
    const name = get("name");
    if (name) row.name = name.slice(0, 120);
    const category = get("category");
    if (category) row.category = category.slice(0, 60);
    const description = get("description");
    if (description) row.description = description.slice(0, 500);

    const price = get("price");
    if (price !== undefined) {
      const n = wholeNumber(price, 1_000_000, true);
      if (n === undefined || n === null) problems.push(`price "${price}" is not a number`);
      else if (n !== "") row.price = n;
    }
    const discount = get("discountPrice");
    if (discount !== undefined) {
      const n = wholeNumber(discount, 1_000_000, true);
      if (n === undefined) problems.push(`discount_price "${discount}" is not a number`);
      else if (n !== "") row.discountPrice = n === 0 ? null : n;
    }
    for (const key of ["veg", "available", "popular", "bestseller"] as const) {
      const raw = get(key);
      if (raw === undefined) continue;
      const b = yesNo(raw);
      if (b === undefined) problems.push(`${key} "${raw}" should be yes or no`);
      else if (b !== "") row[key] = b;
    }
    const image = get("imageUrl");
    if (image) {
      if (CLEAR.test(image)) row.imageUrl = null;
      else if (/^https?:\/\/\S{3,480}$/i.test(image)) row.imageUrl = image;
      else problems.push("image_url must be a web address starting with http or https");
    }
    const stock = get("stock");
    if (stock !== undefined) {
      const n = wholeNumber(stock, 100_000);
      if (n === undefined) problems.push(`stock "${stock}" is not a whole number`);
      else if (n !== "") row.stock = n;
    }
    const low = get("lowStockAt");
    if (low !== undefined) {
      const n = wholeNumber(low, 100_000);
      if (n === undefined) problems.push(`low_stock_at "${low}" is not a whole number`);
      else if (n !== "") row.lowStockAt = n;
    }

    if (!row.id && !row.name) {
      // A wholly empty row is just spacing; one with other cells filled is a mistake.
      const any = cells.some((c) => cellText(c) !== "");
      if (any) issues.push({ line, message: "Needs an id or a name" });
      return;
    }
    if (row.discountPrice != null && row.price != null && row.discountPrice >= row.price) {
      problems.push("discount_price must be lower than price");
    }
    if (problems.length > 0) {
      issues.push({ line, message: problems.join("; ") });
      return;
    }
    rows.push(row);
  });

  return { rows, issues, columns, unknownColumns: unknown, truncated };
}

/** A cell as the template writes it. */
function templateCell(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value as string | number;
}

export interface TemplateItem {
  id?: string | null;
  name: string;
  category?: string | null;
  price: number;
  discountPrice?: number | null;
  description?: string | null;
  veg: boolean;
  available: boolean;
  popular?: boolean;
  bestseller?: boolean;
  imageUrl?: string | null;
  stock?: number | null;
  lowStockAt?: number | null;
}

/** The sheet's rows as cell values: the header row, then one row per dish. */
export function templateGrid(items: TemplateItem[], columns: ColumnKey[] = TEMPLATE_COLUMNS.map((c) => c.key)): (string | number)[][] {
  const cols = TEMPLATE_COLUMNS.filter((c) => columns.includes(c.key));
  const head = cols.map((c) => c.header);
  const body = items.map((it) => cols.map((c) => templateCell(it[c.key as keyof TemplateItem])));
  return [head, ...body];
}

/** Example rows for an empty template. */
export const EXAMPLE_ITEMS: TemplateItem[] = [
  { id: "item-001", name: "Paneer Butter Masala", category: "Mains", price: 249, discountPrice: 219, description: "Creamy tomato gravy", veg: true, available: true, popular: true, bestseller: false, imageUrl: "", stock: 40, lowStockAt: 5 },
  { id: "item-002", name: "Chicken Biryani", category: "Rice", price: 299, discountPrice: null, description: "Hyderabadi style", veg: false, available: true, popular: false, bestseller: true, imageUrl: "", stock: null, lowStockAt: null },
];

/**
 * A grid as the file to download. A cell that a spreadsheet would read as a
 * formula (=, +, -, @ first) gets a leading apostrophe-free guard: a space is
 * wrong for ids, so those cells are quoted text instead.
 */
export function gridToCsv(grid: (string | number)[][]): string {
  const cell = (v: string | number) => {
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${grid.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function gridToXlsx(grid: (string | number)[][], sheetName = "Menu"): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
