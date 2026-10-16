/**
 * Read + normalize tables from the phpMyAdmin JSON export of u231346219_deligro.
 */

import { readFileSync } from "node:fs";
import {
  unsplashForMenuItem,
  unsplashForRestaurant,
} from "./unsplash-images";

export interface LegacyShop {
  id: string;
  location_id: string;
  sname: string;
  saddress: string;
  simage: string;
  aimage: string;
  banner: string;
  famous: string;
  promoted: string;
  rating: string;
  email: string;
  phone: string;
  status: string;
  approve: string;
  tags: string;
  deliverytime: string;
  timing: string;
  lat: string;
  slong: string;
}

export interface LegacyProduct {
  id: string;
  category_id: string;
  shop_id: string;
  pname: string;
  punit: string;
  price: string;
  mrp: string;
  pdesc: string;
  pimage: string;
  aimage: string;
  status: string;
  badge: string;
}

export interface LegacyCategory {
  id: string;
  shop_id: string;
  category_name: string;
  status: string;
}

export interface LegacyReview {
  shop_id: string;
  star_shop: string;
}

interface LegacySettings {
  min_order_amount: string;
  free_delivery: string;
  perkm: string;
  delivery_radius: string;
  tax: string;
}

interface LegacyCustomer {
  id: string;
  userphone: string;
  username: string;
  useraddress: string;
  city: string;
  latuser?: string;
  longuser?: string;
}

/** One row from the legacy `orders` table (phpMyAdmin JSON). */
export interface LegacyOrder {
  id: string;
  location_id: string;
  shop_id: string;
  user_id: string;
  dboy_id: string;
  uname: string;
  ophone: string;
  /** HTML cart snapshot — lines joined with `<br>`. */
  pname: string;
  /** Grand total paid (items + delivery − promo − wallet), rupees. */
  price: string;
  dcharge: string;
  tax: string;
  wallet: string;
  promo_amount: string;
  status: string;
  tid: string;
  ordertime: string;
  shop_otp: string;
  user_otp: string;
  cancel_reason: string;
}

export interface ParsedOrderLine {
  name: string;
  qty: number;
  /** Unit price in whole rupees. */
  price: number;
}

export interface LegacyExport {
  shops: LegacyShop[];
  products: LegacyProduct[];
  categories: LegacyCategory[];
  reviews: LegacyReview[];
  customers: LegacyCustomer[];
  orders: LegacyOrder[];
  settings: LegacySettings | null;
}

type JsonChunk =
  | { type: "header" }
  | { type: "database" }
  | { type: "table"; name: string; data: Record<string, string>[] };

export function loadLegacyExport(jsonPath: string): LegacyExport {
  const raw = readFileSync(jsonPath, "utf8");
  const chunks = JSON.parse(raw) as JsonChunk[];

  const table = (name: string) => {
    const chunk = chunks.find(
      (c): c is Extract<JsonChunk, { type: "table" }> =>
        c.type === "table" && c.name === name
    );
    return (chunk?.data ?? []) as Record<string, string>[];
  };

  const settingsRows = table("settings");

  return {
    shops: table("shop") as LegacyShop[],
    products: table("products") as LegacyProduct[],
    categories: table("category") as LegacyCategory[],
    reviews: table("review") as LegacyReview[],
    customers: table("user") as LegacyCustomer[],
    orders: table("orders") as LegacyOrder[],
    settings: settingsRows[0]
      ? ({
          min_order_amount: settingsRows[0].min_order_amount ?? "0",
          free_delivery: settingsRows[0].free_delivery ?? "0",
          perkm: settingsRows[0].perkm ?? "0",
          delivery_radius: settingsRows[0].delivery_radius ?? "0",
          tax: settingsRows[0].tax ?? "0",
        } satisfies LegacySettings)
      : null,
  };
}

/**
 * Parse the legacy cart snapshot stored in `orders.pname`.
 *
 * Typical line: `✰ Paneer Chilli  Qty-1X Plate (Rs.90)`
 * Lines are joined with `<br>`; a few rows omit Qty / use odd spacing.
 */
export function parsePnameHtml(pname: string): ParsedOrderLine[] {
  const chunks = pname
    .split(/<br\s*(?:\/\s*)?>/i)
    .flatMap((chunk) =>
      // Some rows jam two dishes together without a <br>.
      chunk.split(/(?=✰)/g)
    )
    .map((c) =>
      trimTrailingCommas(
        c
          .replace(/✰/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/[<>]/g, " ")
          .replace(/\s+/g, " ")
      ).trim()
    )
    .filter(Boolean);

  const lines: ParsedOrderLine[] = [];

  for (const raw of chunks) {
    // Primary: Name Qty-NX Unit (Rs.PRICE) — tolerate spacing / double ))
    const q = matchQtyLine(raw);
    if (q) {
      const name = cleanItemName(q.name, q.unit);
      const qty = normalizeQty(q.qty);
      const price = Math.round(Number.parseFloat(q.price));
      if (name && qty > 0 && Number.isFinite(price) && price >= 0) {
        lines.push({ name, qty, price });
        continue;
      }
    }

    // Fallback: Name (Rs.PRICE) or Name (PRICE) with implied qty 1
    const p = matchPricedLine(raw);
    if (p) {
      const name = cleanItemName(p.name, "");
      const price = Math.round(Number.parseFloat(p.price));
      if (name && Number.isFinite(price) && price >= 0) {
        lines.push({ name, qty: 1, price });
      }
    }
  }

  return lines;
}

/*
 * The two line shapes used to be single regexes, each opening with a lazy
 * `^(.*?)\s*` name. That backtracks super-linearly (every split of the name
 * against the whitespace is retried), so they are matched in pieces instead,
 * with the same captures:
 *
 *   Name Qty-NX Unit (Rs.PRICE)   /^(.*?)\s+Qty\s*-?\s*(\d+(?:\.\d+)?)\s*X\s*(.*?)\s*\(\s*Rs\.?\s*([\d.]+)\s*\)\)?$/i
 *   Name (Rs.PRICE) / Name (PRICE) /^(.*?)\s*\(\s*(?:Rs\.?\s*)?([\d.]+)\s*\)\s*$/i
 *
 * Neither price tail can contain a "(", so it always starts at the LAST "(";
 * the lazy name/unit before it is whatever precedes that, minus the whitespace
 * the tail's leading `\s*` would have taken. `raw` never contains a line
 * terminator (parsePnameHtml collapses all whitespace first), so `.` in the
 * old patterns matched every character here.
 */
const RS_PRICE_TAIL = /^\(\s*Rs\.?\s*([\d.]+)\s*\)\)?$/i;
const PRICE_TAIL = /^\(\s*(?:Rs\.?\s*)?([\d.]+)\s*\)\s*$/i;
const QTY_WORD = /qty/gi;
const QTY_COUNT = /\s*(?:-\s*)?(\d+(?:\.\d+)?)\s*X\s*/iy;

/** Index where the whitespace run ending at `end` starts, not below `floor`. */
function wsRunStart(s: string, end: number, floor = 0): number {
  let i = end;
  while (i > floor && /\s/.test(s[i - 1])) i--;
  return i;
}

/** `.replace(/[,\s]+$/, "")` without rescanning the tail from every start. */
function trimTrailingCommas(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "," || /\s/.test(s[end - 1]))) end--;
  return s.slice(0, end);
}

function matchQtyLine(
  raw: string
): { name: string; qty: string; unit: string; price: string } | null {
  const open = raw.lastIndexOf("(");
  if (open === -1) return null;
  const tail = RS_PRICE_TAIL.exec(raw.slice(open));
  if (!tail) return null;
  // The first "Qty" with whitespace before it and a count after it wins, as
  // the lazy name would have found it.
  for (const hit of raw.slice(0, open).matchAll(QTY_WORD)) {
    const nameEnd = wsRunStart(raw, hit.index);
    if (nameEnd === hit.index) continue;
    QTY_COUNT.lastIndex = hit.index + hit[0].length;
    const count = QTY_COUNT.exec(raw);
    if (!count || QTY_COUNT.lastIndex > open) continue;
    const unitStart = QTY_COUNT.lastIndex;
    return {
      name: raw.slice(0, nameEnd),
      qty: count[1],
      unit: raw.slice(unitStart, wsRunStart(raw, open, unitStart)),
      price: tail[1],
    };
  }
  return null;
}

function matchPricedLine(raw: string): { name: string; price: string } | null {
  const open = raw.lastIndexOf("(");
  if (open === -1) return null;
  const tail = PRICE_TAIL.exec(raw.slice(open));
  if (!tail) return null;
  return { name: raw.slice(0, wsRunStart(raw, open)), price: tail[1] };
}

function cleanItemName(name: string, unit: string): string {
  let n = name.replace(/\s+/g, " ").trim();
  const u = unit.replace(/\s+/g, " ").trim();
  // Keep unit only when it isn't the meaningless default "Plate"/empty.
  if (u && !/^(plate|piece|pack|packet|glass|cup|kg)?$/i.test(u)) {
    n = `${n} (${u})`;
  }
  return n.slice(0, 200);
}

function normalizeQty(raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round(n));
}

/** Map legacy order status strings onto our order_status enum. */
export function mapLegacyOrderStatus(
  status: string
): "delivered" | "cancelled" | "on_the_way" | "placed" {
  const s = status.trim().toUpperCase();
  if (s.includes("CANCEL")) return "cancelled";
  if (s.includes("DELIVER")) return "delivered";
  if (s.includes("PICK")) return "on_the_way";
  return "placed";
}

/**
 * Legacy ordertime is `DD/MM/YYYY hh:mm:ssam` (12h). Returns ISO or null.
 */
export function parseLegacyOrderTime(ordertime: string): string | null {
  const m =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)$/i.exec(
      ordertime.trim()
    );
  if (!m) return null;
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ampm = m[7].toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  // Store as IST wall-clock with an explicit +05:30 offset.
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoLocal = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+05:30`;
  const d = new Date(isoLocal);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Which legacy restaurants to include in an import run. */
export type ShopImportScope = "bemetara" | "active" | "approved";

const BEMETARA_LOCATION_ID = "1";
const BEMETARA_TEXT =
  /bemetara|बेमेतरा|491335|raipur\s*road|kobiya|bhimbhori|berla/i;

/** True when the shop belongs to the Bemetara service area. */
export function isBemetaraShop(shop: LegacyShop): boolean {
  if (shop.location_id === BEMETARA_LOCATION_ID) return true;
  const text = `${shop.saddress} ${shop.sname}`.toLowerCase();
  return BEMETARA_TEXT.test(text);
}

/**
 * Pick restaurants for import.
 * Default `bemetara` — all shops in the Bemetara city (active + inactive).
 */
export function selectShops(
  shops: LegacyShop[],
  scope: ShopImportScope = "bemetara"
): LegacyShop[] {
  switch (scope) {
    case "active":
      return shops.filter((s) => s.status === "ON");
    case "approved":
      return shops.filter((s) => s.approve === "YES");
    case "bemetara":
    default:
      return shops.filter(isBemetaraShop);
  }
}

export function resolveShopImportScope(): ShopImportScope {
  const raw = process.env.LEGACY_SHOP_SCOPE?.toLowerCase();
  if (raw === "active" || raw === "approved" || raw === "bemetara") return raw;
  // Back-compat with the old env flag
  if (process.env.IMPORT_ALL_APPROVED === "1") return "approved";
  return "bemetara";
}

export function shopSlug(shop: LegacyShop): string {
  const base = slugify(shop.sname);
  return base ? `${base}-${shop.id}` : `shop-${shop.id}`;
}

function slugify(value: string): string {
  const dashed = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-");
  // Trim the dashes by hand: an unanchored `-+$` rescans every dash run.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === "-") start++;
  while (end > start && dashed[end - 1] === "-") end--;
  return dashed.slice(start, end).slice(0, 48);
}

const NON_VEG_RE =
  /\b(chicken|mutton|fish|egg|prawn|meat|beef|pork|lamb|crab|keema|sausage)\b/i;

export function inferVeg(name: string): boolean {
  return !NON_VEG_RE.test(name);
}

const CUISINE_KEYWORDS: [RegExp, string][] = [
  [/\b(biryani)\b/i, "Biryani"],
  [/\b(chinese|chowmein|noodle|schezwan|manchurian)\b/i, "Chinese"],
  [/\b(pizza|pasta|italian)\b/i, "Italian"],
  [/\b(dosa|idli|sambar|uttapam|south)\b/i, "South Indian"],
  [/\b(north|tandoori|paratha|dal|roti|paneer)\b/i, "North Indian"],
  [/\b(burger|momos?|fast)\b/i, "Fast Food"],
  [/\b(salad|healthy)\b/i, "Healthy"],
  [/\b(cake|dessert|sweet|ice)\b/i, "Desserts"],
];

/** Words in a shop's "famous for" field that are themselves a cuisine name. */
function famousCuisines(famous: string): string[] {
  const out: string[] = [];
  for (const part of famous.split(/[\s,/]+/)) {
    const p = part.trim();
    if (p.length > 2 && !/^(no|foods)$/i.test(p)) {
      const titled =
        p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      if (
        [
          "North Indian",
          "South Indian",
          "Chinese",
          "Italian",
          "Fast Food",
          "Healthy",
          "Desserts",
          "Biryani",
        ].includes(titled)
      ) {
        out.push(titled);
      }
    }
  }
  return out;
}

export function inferCuisines(shop: LegacyShop): string[] {
  const text = `${shop.famous} ${shop.tags} ${shop.sname}`.toLowerCase();
  const found = new Set<string>();

  for (const [re, cuisine] of CUISINE_KEYWORDS) {
    if (re.test(text)) found.add(cuisine);
  }

  if (shop.famous && shop.famous !== "NO" && shop.famous !== "Foods") {
    for (const cuisine of famousCuisines(shop.famous)) found.add(cuisine);
  }

  if (found.size === 0) found.add("Fast Food");
  return [...found].slice(0, 3);
}

export function parseEtaMinutes(deliverytime: string): {
  etaMin: number;
  etaMax: number;
} {
  const match = /(\d+)/.exec(deliverytime);
  const min = match ? Number(match[1]) : 25;
  return { etaMin: min, etaMax: min + 10 };
}

export function parsePrice(value: string): number {
  const n = Math.round(Number.parseFloat(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function resolveLegacyImageWithBase(
  baseUrl: string | undefined,
  ...paths: (string | undefined | null)[]
): string | null {
  for (const p of paths) {
    if (!p || p === "None" || p.trim() === "") continue;
    if (p.startsWith("http://") || p.startsWith("https://")) return p;
    if (baseUrl) {
      const base = baseUrl.replace(/\/$/, "");
      const path = p.replace(/^\//, "");
      return `${base}/${path}`;
    }
  }
  return null;
}

export function buildCategoryMap(categories: LegacyCategory[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of categories) {
    if (c.status === "OFF") continue;
    map.set(c.id, c.category_name.trim() || "Popular");
  }
  return map;
}

export function aggregateShopRatings(
  reviews: LegacyReview[],
  shopIds: Set<string>
): Map<string, { rating: number; ratingCount: number }> {
  const buckets = new Map<string, number[]>();
  for (const r of reviews) {
    if (!shopIds.has(r.shop_id)) continue;
    const star = Number.parseFloat(r.star_shop);
    if (!Number.isFinite(star)) continue;
    const list = buckets.get(r.shop_id) ?? [];
    list.push(star);
    buckets.set(r.shop_id, list);
  }

  const out = new Map<string, { rating: number; ratingCount: number }>();
  for (const [id, stars] of buckets) {
    const ratingCount = stars.length;
    const rating =
      Math.round((stars.reduce((a, b) => a + b, 0) / ratingCount) * 10) / 10;
    out.set(id, { rating, ratingCount });
  }
  return out;
}

export function productsForShop(
  products: LegacyProduct[],
  shopId: string,
  includeOff = false
): LegacyProduct[] {
  return products.filter((p) => {
    if (p.shop_id !== shopId) return false;
    if (!includeOff && p.status !== "ON") return false;
    return true;
  });
}

export interface SeedImageOptions {
  /** If set, relative legacy paths resolve against this base URL. */
  assetsBaseUrl?: string;
  /**
   * Fill missing images with a curated Unsplash stock photo (default true). The
   * field keeps its legacy name (and the USE_PEXELS_IMAGES env var) for
   * compatibility; the stock source is now Unsplash, see ./unsplash-images.
   */
  usePexels?: boolean;
}

/**
 * Restaurant image: legacy file (if base URL + path exist) else Unsplash.
 */
export function resolveRestaurantSeedImage(
  shop: LegacyShop,
  cuisines: string[],
  opts: SeedImageOptions = {}
): string {
  const usePexels = opts.usePexels !== false;
  const legacy = resolveLegacyImageWithBase(
    opts.assetsBaseUrl,
    shop.banner,
    shop.aimage,
    shop.simage
  );
  if (legacy) return legacy;
  if (usePexels) return unsplashForRestaurant(shop.sname, cuisines, shop.famous);
  return "";
}

export interface MenuSeedImageInput {
  aimage?: string | null;
  pimage?: string | null;
  description?: string | null;
}

/**
 * Menu item image: legacy file else Unsplash by category + name (+ description hint).
 */
export function resolveMenuSeedImage(
  category: string,
  itemName: string,
  opts: SeedImageOptions,
  legacy: MenuSeedImageInput = {}
): string | null {
  const usePexels = opts.usePexels !== false;
  const fromFile = resolveLegacyImageWithBase(
    opts.assetsBaseUrl,
    legacy.aimage,
    legacy.pimage
  );
  if (fromFile) return fromFile;
  if (usePexels) {
    return unsplashForMenuItem(
      category,
      itemName,
      legacy.description?.trim() ?? ""
    );
  }
  return null;
}
