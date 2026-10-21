/**
 * The Manager app's product shapes (Phase 4 plan, "API contract"), the product
 * list query, the stock definitions behind its counts, and the insights
 * builder. Pure: no I/O.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { decodeNameCursor, parseLimit, type PersonRef } from "./vendor-contract";
import {
  availabilityStats,
  frequentlyUnavailable,
  priceChangePct,
  rankSellers,
  type AllowedProductActions,
  type AvailabilityChange,
  type Range,
} from "./product-rules";

export const AVAILABILITY_FILTERS = ["available", "unavailable", "out_of_stock", "low_stock"] as const;
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const UNCATEGORISED = "Uncategorised";

export interface ProductListItem {
  id: string;
  name: string;
  vendor: { id: string; name: string };
  category: string | null;
  price: number;
  discountPrice: number | null;
  pendingPrice: number | null;
  imageUrl: string | null;
  veg: boolean;
  available: boolean;
  stockQty: number | null;
  lowStockAt: number | null;
  soldOutByStock: boolean;
  approvalStatus: ApprovalStatus;
  hidden: boolean;
  openFlags: number;
  updatedAt: string | null;
}

export interface ProductCounts {
  unavailable: number;
  outOfStock: number;
  lowStock: number;
  pendingApproval: number;
  openFlags: number;
  hidden: number;
}

export interface ProductChange {
  id: number;
  field: string;
  from: string | null;
  to: string | null;
  source: "vendor" | "ops" | "admin" | "system";
  actor: { id: string; name: string; role: string } | null;
  at: string;
}

export interface ListingFlag {
  id: string;
  reason: string;
  note: string | null;
  status: "open" | "resolved" | "dismissed";
  raisedBy: PersonRef;
  raisedAt: string;
  resolution: string | null;
  resolvedBy: PersonRef | null;
  resolvedAt: string | null;
}

export interface ProductSales {
  from: string;
  to: string;
  units: number;
  revenue: number;
  orders: number;
  rankInVendor: number | null;
  daily: { date: string; units: number }[];
}

export interface ProductDetail extends ProductListItem {
  description: string | null;
  variants: { name: string; price: number }[];
  addonGroups: { name: string; addons: { name: string; price: number }[] }[];
  approvalNote: string | null;
  hiddenReason: string | null;
  changes: ProductChange[];
  flags: ListingFlag[];
  sales: ProductSales;
  availability: { timesUnavailable: number; hoursUnavailable: number };
  allowed: AllowedProductActions;
}

// ── query ────────────────────────────────────────────────────────────────────

export interface ProductQuery {
  q: string | null;
  vendor: string | null;
  category: string | null;
  availability: AvailabilityFilter | null;
  approval: ApprovalStatus | null;
  flagged: boolean;
  hidden: boolean;
  zone: string | null;
  cursor: { name: string; id: string } | null;
  limit: number;
}

export function parseProductQuery(params: URLSearchParams): { ok: true; query: ProductQuery } | { ok: false; field: string } {
  const q = (params.get("q") ?? "").trim();
  if (q !== "" && (q.length < 2 || q.length > 80)) return { ok: false, field: "q" };
  const vendor = params.get("vendor");
  if (vendor && !isUuid(vendor)) return { ok: false, field: "vendor" };
  const category = (params.get("category") ?? "").trim();
  if (category.length > 60) return { ok: false, field: "category" };
  const availability = params.get("availability");
  if (availability && !AVAILABILITY_FILTERS.includes(availability as AvailabilityFilter)) return { ok: false, field: "availability" };
  const approval = params.get("approval");
  if (approval && !APPROVAL_STATUSES.includes(approval as ApprovalStatus)) return { ok: false, field: "approval" };
  const flagged = params.get("flagged");
  if (flagged && flagged !== "open") return { ok: false, field: "flagged" };
  const hidden = params.get("hidden");
  if (hidden && hidden !== "true") return { ok: false, field: "hidden" };
  const zone = params.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };
  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw ? decodeNameCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { ok: false, field: "cursor" };
  const limit = parseLimit(params.get("limit"));
  if (limit === null) return { ok: false, field: "limit" };
  return {
    ok: true,
    query: {
      q: q || null,
      vendor: vendor ? vendor.toLowerCase() : null,
      category: category || null,
      availability: (availability as AvailabilityFilter) || null,
      approval: (approval as ApprovalStatus) || null,
      flagged: flagged === "open",
      hidden: hidden === "true",
      zone: zone ? zone.toLowerCase() : null,
      cursor,
      limit,
    },
  };
}

// ── rows and serialisers ─────────────────────────────────────────────────────

type One<T> = T | T[] | null;
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v);

export interface ProductRow {
  id: string;
  name: string;
  restaurant_id: string;
  category: string | null;
  price: number;
  discount_price: number | null;
  pending_price: number | null;
  image_url: string | null;
  veg: boolean | null;
  available: boolean;
  stock_qty: number | null;
  low_stock_at: number | null;
  sold_out_by_stock: boolean | null;
  approval_status: string;
  hidden_by_ops: boolean;
  updated_at: string | null;
  restaurants: One<{ name: string | null; zone_id: string }>;
}

export const PRODUCT_COLUMNS =
  "id, name, restaurant_id, category, price, discount_price, pending_price, image_url, veg, available, stock_qty, " +
  "low_stock_at, sold_out_by_stock, approval_status, hidden_by_ops, updated_at, restaurants!inner(name, zone_id)";

/** Sold out by stock, or tracked and at 0. */
export function isOutOfStock(r: Pick<ProductRow, "stock_qty" | "sold_out_by_stock">): boolean {
  return r.sold_out_by_stock === true || r.stock_qty === 0;
}

/** Tracked, above 0, at or under its low-stock mark. */
export function isLowStock(r: Pick<ProductRow, "stock_qty" | "low_stock_at">): boolean {
  return r.stock_qty !== null && r.stock_qty > 0 && r.low_stock_at !== null && r.stock_qty <= r.low_stock_at;
}

export function toProductListItem(r: ProductRow, openFlags: number): ProductListItem {
  const shop = one(r.restaurants);
  return {
    id: r.id,
    name: r.name,
    vendor: { id: r.restaurant_id, name: shop?.name?.trim() || "Shop" },
    category: r.category ?? null,
    price: r.price,
    discountPrice: r.discount_price ?? null,
    pendingPrice: r.pending_price ?? null,
    imageUrl: r.image_url ?? null,
    veg: r.veg !== false,
    available: r.available,
    stockQty: r.stock_qty ?? null,
    lowStockAt: r.low_stock_at ?? null,
    soldOutByStock: r.sold_out_by_stock === true,
    approvalStatus: (APPROVAL_STATUSES.includes(r.approval_status as ApprovalStatus) ? r.approval_status : "approved") as ApprovalStatus,
    hidden: r.hidden_by_ops === true,
    openFlags,
    updatedAt: r.updated_at ?? null,
  };
}

export interface ProductDetailInput {
  row: ProductRow;
  extra: { description: string | null; approval_note: string | null; hidden_reason: string | null };
  openFlags: number;
  variants: { name: string; price: number }[];
  addonGroups: { name: string; addons: { name: string; price: number }[] }[];
  changes: ProductChange[];
  flags: ListingFlag[];
  sales: ProductSales;
  availability: { timesUnavailable: number; hoursUnavailable: number };
  allowed: AllowedProductActions;
}

export function toProductDetail(input: ProductDetailInput): ProductDetail {
  return {
    ...toProductListItem(input.row, input.openFlags),
    description: input.extra.description ?? null,
    variants: input.variants,
    addonGroups: input.addonGroups,
    approvalNote: input.extra.approval_note ?? null,
    hiddenReason: input.extra.hidden_reason ?? null,
    changes: input.changes,
    flags: input.flags,
    sales: input.sales,
    availability: input.availability,
    allowed: input.allowed,
  };
}

// ── insights ─────────────────────────────────────────────────────────────────

export interface PriceChangeRow { itemId: string; at: string; from: string | null; to: string | null; source: string }

export interface ProductInsights {
  frequentlyUnavailable: { product: ProductListItem; timesUnavailable: number; hoursUnavailable: number }[];
  priceChanges: { product: ProductListItem; from: number; to: number; changePct: number | null; at: string; source: string }[];
  topSellers: { product: ProductListItem; units: number; revenue: number }[];
  slowSellers: { product: ProductListItem; units: number; revenue: number }[];
  outOfStock: ProductListItem[];
}

/**
 * §12.3, §12.5, §12.6, §12.10 for a set of dishes in scope. Sellers rank only
 * dishes a customer could buy (available, not hidden, live); price changes are
 * those inside the range, newest first.
 */
export function buildProductInsights(input: {
  items: ProductRow[];
  sales: Map<string, { units: number; revenue: number }>;
  availabilityChanges: AvailabilityChange[];
  priceChanges: PriceChangeRow[];
  range: Range;
  limit: number;
  openFlags?: Map<string, number>;
}): ProductInsights {
  const flags = input.openFlags ?? new Map<string, number>();
  const list = new Map(input.items.map((r) => [r.id, toProductListItem(r, flags.get(r.id) ?? 0)]));
  const sellable = input.items.filter((r) => r.available && !r.hidden_by_ops && r.approval_status !== "rejected"
    && !(r.approval_status === "pending" && r.pending_price === null));
  const withSales = sellable.map((r) => ({ product: list.get(r.id)!, ...(input.sales.get(r.id) ?? { units: 0, revenue: 0 }) }));
  const start = input.range.start.getTime();
  const end = input.range.endExclusive.getTime();
  return {
    frequentlyUnavailable: frequentlyUnavailable(input.items, input.availabilityChanges, input.range)
      .slice(0, input.limit)
      .map((f) => ({ product: list.get(f.item.id)!, timesUnavailable: f.timesUnavailable, hoursUnavailable: f.hoursUnavailable })),
    priceChanges: input.priceChanges
      .filter((c) => list.has(c.itemId) && Date.parse(c.at) >= start && Date.parse(c.at) < end)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, input.limit)
      .map((c) => {
        const from = Number(c.from ?? 0);
        const to = Number(c.to ?? 0);
        return { product: list.get(c.itemId)!, from, to, changePct: priceChangePct(from, to), at: c.at, source: c.source };
      }),
    topSellers: rankSellers(withSales.filter((s) => s.units > 0), "top", input.limit),
    slowSellers: rankSellers(withSales, "slow", input.limit),
    outOfStock: input.items.filter((r) => isOutOfStock(r)).slice(0, input.limit).map((r) => list.get(r.id)!),
  };
}

/** One dish's availability over a range (detail screen). */
export function productAvailability(row: Pick<ProductRow, "id" | "available">, changes: AvailabilityChange[], range: Range) {
  return availabilityStats(row.id, changes, row.available, range);
}
