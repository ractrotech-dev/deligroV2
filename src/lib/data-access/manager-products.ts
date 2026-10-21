import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import { addDays, istDayKey, istDayStart, rangeBounds } from "@/lib/metrics/ist";
import type { DateRange } from "@/lib/metrics";
import { allowedProductActions, availabilityStats, type AvailabilityChange } from "@/lib/ops/product-rules";
import { encodeNameCursor } from "@/lib/ops/vendor-contract";
import {
  PRODUCT_COLUMNS,
  UNCATEGORISED,
  aggregateCategories,
  assembleProductInsights,
  isLowStock,
  type InsightSqlRow,
  toProductDetail,
  toProductListItem,
  type CategoryCount,
  type ListingFlag,
  type ProductChange,
  type ProductCounts,
  type ProductDetail,
  type ProductInsights,
  type ProductListItem,
  type ProductQuery,
  type ProductRow,
} from "@/lib/ops/product-contract";

/**
 * Manager products (§12): dishes across the shops in a manager's zones. Every
 * read is the service role, so every `menu_items` read goes through `inScope`
 * (an inner join to the shop and its zone). Sales are summed in Postgres
 * (ops_product_sales / ops_product_daily, 0146). Callers authorise first
 * (managerApiContext("manager.products.view")).
 */

/** The builder methods this module chains, so the zone filter applies to any select. */
type Q = {
  in(column: string, values: readonly unknown[]): Q;
  eq(column: string, value: unknown): Q;
  or(filter: string): Q;
  is(column: string, value: null | boolean): Q;
  not(column: string, op: string, value: unknown): Q;
  ilike(column: string, pattern: string): Q;
  gt(column: string, value: unknown): Q;
  order(column: string, opts?: { ascending?: boolean }): Q;
  limit(n: number): Q;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown; count?: number | null }>;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
} & PromiseLike<{ data: unknown[] | null; error: unknown; count: number | null }>;

/** Limit a menu_items query (selected with `restaurants!inner(...)`) to the scope's zones. */
function inScope(query: unknown, scope: ManagerScope): Q {
  const q = query as Q;
  const zones = scopeZoneIds(scope);
  return zones ? q.in("restaurants.zone_id", zones) : q;
}

const pgQuote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const searchTerm = (q: string) => q.replace(/[,()*%"\\:]/g, " ").replace(/\s+/g, " ").trim();

async function openFlagCounts(itemIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0) return out;
  const { data, error } = await readInChunks<{ menu_item_id: string }>(itemIds, (chunk) =>
    createAdminClient().from("listing_flags").select("menu_item_id").eq("status", "open").in("menu_item_id", chunk)
  );
  if (error) throw error;
  for (const r of data ?? []) out.set(r.menu_item_id, (out.get(r.menu_item_id) ?? 0) + 1);
  return out;
}

// ── list ─────────────────────────────────────────────────────────────────────

export async function listManagerProducts(
  scope: ManagerScope,
  q: ProductQuery
): Promise<{ items: ProductListItem[]; nextCursor: string | null; counts: ProductCounts | null }> {
  const effective = narrowScope(scope, q.zone);
  const supabase = createAdminClient();
  const term = q.q ? searchTerm(q.q) : "";

  const shared = (query: Q): Q => {
    let out = query;
    if (term) out = out.ilike("name", `%${term}%`);
    if (q.vendor) out = out.eq("restaurant_id", q.vendor);
    if (q.category) out = q.category === UNCATEGORISED ? out.is("category", null) : out.eq("category", q.category);
    return out;
  };

  // "Flagged" joins the dish's open flags: no platform-wide id list in the URL.
  const columns = q.flagged ? `${PRODUCT_COLUMNS}, listing_flags!inner(status)` : PRODUCT_COLUMNS;
  let query = shared(inScope(supabase.from("menu_items").select(columns), effective));
  if (q.availability === "available") query = query.eq("available", true);
  if (q.availability === "unavailable") query = query.eq("available", false);
  if (q.availability === "out_of_stock") query = query.or("sold_out_by_stock.eq.true,stock_qty.eq.0");
  if (q.availability === "low_stock") query = query.gt("stock_qty", 0).not("low_stock_at", "is", null);
  if (q.approval) query = query.eq("approval_status", q.approval);
  if (q.hidden) query = query.eq("hidden_by_ops", true);
  if (q.flagged) query = query.eq("listing_flags.status", "open");
  if (q.cursor) query = query.or(`name.gt.${pgQuote(q.cursor.name)},and(name.eq.${pgQuote(q.cursor.name)},id.gt.${q.cursor.id})`);

  // Low stock compares two columns, which PostgREST cannot: read a wider page and filter.
  const want = q.availability === "low_stock" ? q.limit * 4 : q.limit;
  const { data, error } = await query.order("name", { ascending: true }).order("id", { ascending: true }).limit(want + 1);
  if (error) throw error;
  let rows = (data ?? []) as ProductRow[];
  const more = rows.length > want;
  rows = rows.slice(0, want);
  if (q.availability === "low_stock") rows = rows.filter(isLowStock);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const nextCursor = (more || rows.length > q.limit) && last ? encodeNameCursor(last.name, last.id) : null;

  // Counts head the first page; a later page is the same list, so it repeats none.
  const [flags, counts] = await Promise.all([
    openFlagCounts(page.map((r) => r.id)),
    q.cursor ? null : productCounts(effective, q, term),
  ]);
  return { items: page.map((r) => toProductListItem(r, flags.get(r.id) ?? 0)), nextCursor, counts };
}

/** The list's counts for the same zone, shop, category and search: one query (ops_product_counts, 0146). */
async function productCounts(scope: ManagerScope, q: ProductQuery, term: string): Promise<ProductCounts> {
  const zones = scopeZoneIds(scope);
  const { data, error } = await createAdminClient().rpc("ops_product_counts", {
    p_zone_ids: zones ? [...zones] : null,
    p_restaurant: q.vendor,
    p_category: q.category && q.category !== UNCATEGORISED ? q.category : null,
    p_uncategorised: q.category === UNCATEGORISED,
    p_term: term || null,
  });
  if (error) throw error;
  const r = ((data ?? []) as Record<string, number>[])[0] ?? {};
  return {
    unavailable: Number(r.unavailable ?? 0),
    outOfStock: Number(r.out_of_stock ?? 0),
    lowStock: Number(r.low_stock ?? 0),
    pendingApproval: Number(r.pending_approval ?? 0),
    openFlags: Number(r.open_flags ?? 0),
    hidden: Number(r.hidden ?? 0),
  };
}

// ── categories ───────────────────────────────────────────────────────────────

export async function listProductCategories(
  scope: ManagerScope,
  vendor: string | null
): Promise<CategoryCount[]> {
  const supabase = createAdminClient();
  const [rows, restricted] = await Promise.all([
    readAllRows<{ id: string; category: string | null; available: boolean; restaurant_id: string }>((from, to) => {
      let q = inScope(supabase.from("menu_items").select("id, category, available, restaurant_id, restaurants!inner(zone_id)"), scope);
      if (vendor) q = q.eq("restaurant_id", vendor);
      return q.order("id").range(from, to) as never;
    }),
    listRestrictedCategoryNames(),
  ]);
  if (rows.error) throw rows.error;
  return aggregateCategories(rows.data ?? [], restricted);
}

export async function listRestrictedCategoryNames(): Promise<string[]> {
  const { data, error } = await createAdminClient().from("listing_restricted_categories").select("name");
  if (error) throw error;
  return ((data ?? []) as { name: string }[]).map((r) => r.name);
}

export async function listRestrictedCategories(): Promise<{ name: string; note: string | null; createdAt: string }[]> {
  const { data, error } = await createAdminClient()
    .from("listing_restricted_categories")
    .select("name, note, created_at")
    .order("name");
  if (error) throw error;
  return ((data ?? []) as { name: string; note: string | null; created_at: string }[]).map((r) => ({
    name: r.name,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// ── detail ───────────────────────────────────────────────────────────────────

/** The dish if the scope may see it, else null (missing and out of scope alike). */
export async function scopedProductRow(scope: ManagerScope, id: string): Promise<(ProductRow & { description: string | null; approval_note: string | null; hidden_reason: string | null }) | null> {
  const { data, error } = await inScope(
    createAdminClient().from("menu_items").select(`${PRODUCT_COLUMNS}, description, approval_note, hidden_reason`).eq("id", id),
    scope
  ).maybeSingle();
  if (error) throw error;
  return (data as ProductRow & { description: string | null; approval_note: string | null; hidden_reason: string | null }) ?? null;
}

/** The last 30 IST days, today included. */
function last30(now: Date): DateRange {
  const to = istDayKey(now);
  return { from: addDays(to, -29), to };
}

async function names(ids: (string | null)[]): Promise<Map<string, { name: string; role: string }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, { name: string; role: string }>();
  if (unique.length === 0) return out;
  const { data, error } = await createAdminClient().from("profiles").select("id, full_name, role").in("id", unique);
  if (error) throw error;
  for (const p of (data ?? []) as { id: string; full_name: string | null; role: string }[]) {
    out.set(p.id, { name: p.full_name?.trim() || "User", role: p.role });
  }
  return out;
}

export async function getManagerProductDetail(
  scope: ManagerScope,
  id: string,
  ctx: { permissions: Record<string, boolean>; now: Date }
): Promise<ProductDetail | null> {
  const row = await scopedProductRow(scope, id);
  if (!row) return null;
  const supabase = createAdminClient();
  const range = last30(ctx.now);
  const b = rangeBounds(range);

  const [variants, groups, changes, flags, vendorSales, daily, availChanges] = await Promise.all([
    supabase.from("menu_item_variants").select("name, price").eq("menu_item_id", id).order("sort_order"),
    supabase.from("menu_item_addon_groups").select("name, sort_order, menu_item_addons(name, price, sort_order)").eq("menu_item_id", id).order("sort_order"),
    supabase
      .from("menu_item_changes")
      .select("id, field, old_value, new_value, source, actor_id, created_at")
      .eq("menu_item_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("listing_flags")
      .select("id, reason, note, status, raised_by, raised_at, resolution, resolved_by, resolved_at")
      .eq("menu_item_id", id)
      .order("raised_at", { ascending: false }),
    supabase.rpc("ops_product_sales", {
      p_zone_ids: null, p_start: b.start.toISOString(), p_end: b.endExclusive.toISOString(), p_restaurant: row.restaurant_id,
    }),
    supabase.rpc("ops_product_daily", { p_item: id, p_start: b.start.toISOString(), p_end: b.endExclusive.toISOString() }),
    supabase
      .from("menu_item_changes")
      .select("created_at, new_value")
      .eq("menu_item_id", id)
      .eq("field", "available")
      .gte("created_at", b.start.toISOString())
      .order("created_at"),
  ]);
  for (const r of [variants, groups, changes, flags, vendorSales, daily, availChanges]) if (r.error) throw r.error;

  type ChangeRow = { id: number; field: string; old_value: string | null; new_value: string | null; source: ProductChange["source"]; actor_id: string | null; created_at: string };
  type FlagRow = { id: string; reason: string; note: string | null; status: ListingFlag["status"]; raised_by: string; raised_at: string;
    resolution: string | null; resolved_by: string | null; resolved_at: string | null };
  const changeRows = (changes.data ?? []) as ChangeRow[];
  const flagRows = (flags.data ?? []) as FlagRow[];
  const people = await names([...changeRows.map((c) => c.actor_id), ...flagRows.flatMap((f) => [f.raised_by, f.resolved_by])]);
  const person = (pid: string | null) => (pid ? { id: pid, name: people.get(pid)?.name ?? "User" } : null);

  const sales = (vendorSales.data ?? []) as { menu_item_id: string; units: number; revenue: number; orders: number }[];
  const ranked = [...sales].sort((a, b2) => Number(b2.units) - Number(a.units));
  const mine = sales.find((s) => s.menu_item_id === id);
  const rank = mine ? ranked.findIndex((s) => s.menu_item_id === id) + 1 : null;
  const changesForAvail: AvailabilityChange[] = ((availChanges.data ?? []) as { created_at: string; new_value: string | null }[])
    .map((c) => ({ itemId: id, at: c.created_at, to: c.new_value === "true" }));
  const openFlags = flagRows.filter((f) => f.status === "open").length;

  return toProductDetail({
    row,
    extra: { description: row.description, approval_note: row.approval_note, hidden_reason: row.hidden_reason },
    openFlags,
    variants: ((variants.data ?? []) as { name: string; price: number }[]).map((v) => ({ name: v.name, price: v.price })),
    addonGroups: ((groups.data ?? []) as { name: string; menu_item_addons: { name: string; price: number; sort_order: number }[] | null }[]).map((g) => ({
      name: g.name,
      addons: [...(g.menu_item_addons ?? [])].sort((a, b2) => a.sort_order - b2.sort_order).map((a) => ({ name: a.name, price: a.price })),
    })),
    changes: changeRows.map((c) => ({
      id: Number(c.id),
      field: c.field,
      from: c.old_value,
      to: c.new_value,
      source: c.source,
      actor: c.actor_id ? { id: c.actor_id, name: people.get(c.actor_id)?.name ?? "User", role: people.get(c.actor_id)?.role ?? "" } : null,
      at: c.created_at,
    })),
    flags: flagRows.map((f) => ({
      id: f.id,
      reason: f.reason,
      note: f.note,
      status: f.status,
      raisedBy: person(f.raised_by)!,
      raisedAt: f.raised_at,
      resolution: f.resolution,
      resolvedBy: person(f.resolved_by),
      resolvedAt: f.resolved_at,
    })),
    sales: {
      from: range.from,
      to: range.to,
      units: Number(mine?.units ?? 0),
      revenue: Number(mine?.revenue ?? 0),
      orders: Number(mine?.orders ?? 0),
      rankInVendor: rank,
      daily: ((daily.data ?? []) as { day: string; units: number }[]).map((d) => ({ date: String(d.day).slice(0, 10), units: Number(d.units) })),
    },
    availability: availabilityStats(id, changesForAvail, row.available, b),
    allowed: allowedProductActions({ approvalStatus: row.approval_status, hidden: row.hidden_by_ops, openFlags }, ctx.permissions),
  });
}

// ── insights ─────────────────────────────────────────────────────────────────

export async function getProductInsights(
  scope: ManagerScope,
  range: DateRange,
  vendor: string | null,
  limit = 20
): Promise<{ from: string; to: string } & ProductInsights> {
  const supabase = createAdminClient();
  const b = { start: istDayStart(range.from), endExclusive: istDayStart(addDays(range.to, 1)) };
  const zones = scopeZoneIds(scope);
  // Summed in Postgres and bounded per section (ops_product_insights, 0146): a
  // platform-wide scope never ships its whole menu and change history here.
  const { data, error } = await supabase.rpc("ops_product_insights", {
    p_zone_ids: zones ? [...zones] : null,
    p_restaurant: vendor,
    p_start: b.start.toISOString(),
    p_end: b.endExclusive.toISOString(),
    p_limit: limit,
  });
  if (error) throw error;
  const rows = (data ?? []) as InsightSqlRow[];
  const ids = [...new Set(rows.map((r) => r.menu_item_id))];
  const items = await readInChunks<ProductRow>(ids, (chunk) =>
    inScope(supabase.from("menu_items").select(PRODUCT_COLUMNS).in("id", chunk), scope) as never
  );
  if (items.error) throw items.error;
  const flags = await openFlagCounts(ids);
  return { from: range.from, to: range.to, ...assembleProductInsights(rows, items.data ?? [], flags) };
}

/** For the actions route: the dish's restaurant if the scope may see it. */
export async function productRestaurant(scope: ManagerScope, id: string): Promise<string | null> {
  const row = await scopedProductRow(scope, id);
  return row?.restaurant_id ?? null;
}

// ── image review (§12.7) ─────────────────────────────────────────────────────

export interface ImageReviewItem {
  changeId: number;
  product: ProductListItem;
  previousImageUrl: string | null;
  imageUrl: string;
  changedAt: string;
  changedBy: { id: string; name: string } | null;
}

/**
 * Vendor photos waiting for a look, newest first: a new dish's photo or a
 * changed one, only while it is still the photo the dish shows
 * (ops_image_review_queue, 0146). `before` pages by change id.
 */
export async function listImageReviews(
  scope: ManagerScope,
  q: { vendor: string | null; before: number | null; limit: number }
): Promise<{ items: ImageReviewItem[]; nextBefore: number | null }> {
  const supabase = createAdminClient();
  const zones = scopeZoneIds(scope);
  const { data, error } = await supabase.rpc("ops_image_review_queue", {
    p_zone_ids: zones ? [...zones] : null,
    p_restaurant: q.vendor,
    p_before: q.before,
    p_limit: q.limit + 1,
  });
  if (error) throw error;
  type Row = { change_id: number; menu_item_id: string; old_value: string | null; new_value: string; actor_id: string | null; created_at: string };
  const all = (data ?? []) as Row[];
  const page = all.slice(0, q.limit);
  const ids = [...new Set(page.map((r) => r.menu_item_id))];
  const [items, flags, people] = await Promise.all([
    readInChunks<ProductRow>(ids, (chunk) => inScope(supabase.from("menu_items").select(PRODUCT_COLUMNS).in("id", chunk), scope) as never),
    openFlagCounts(ids),
    names(page.map((r) => r.actor_id)),
  ]);
  if (items.error) throw items.error;
  const byId = new Map((items.data ?? []).map((r) => [r.id, r]));
  const out: ImageReviewItem[] = [];
  for (const r of page) {
    const row = byId.get(r.menu_item_id);
    if (!row) continue;
    out.push({
      changeId: Number(r.change_id),
      product: toProductListItem(row, flags.get(row.id) ?? 0),
      previousImageUrl: r.old_value,
      imageUrl: r.new_value,
      changedAt: new Date(r.created_at).toISOString(),
      changedBy: r.actor_id ? { id: r.actor_id, name: people.get(r.actor_id)?.name ?? "User" } : null,
    });
  }
  const last = page.at(-1);
  return { items: out, nextBefore: all.length > q.limit && last ? Number(last.change_id) : null };
}

/** The dish a queued photo belongs to, if the scope may see it. */
export async function imageChangeProduct(scope: ManagerScope, changeId: number): Promise<{ id: string; name: string; restaurant_id: string } | null> {
  const { data, error } = await createAdminClient()
    .from("menu_item_changes")
    .select("menu_item_id")
    .eq("id", changeId)
    .eq("field", "image_url")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = await scopedProductRow(scope, (data as { menu_item_id: string }).menu_item_id);
  return row ? { id: row.id, name: row.name, restaurant_id: row.restaurant_id } : null;
}
