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
  buildProductInsights,
  isLowStock,
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

async function openlyFlaggedIds(): Promise<string[]> {
  const { data, error } = await readAllRows<{ menu_item_id: string }>((from, to) =>
    createAdminClient().from("listing_flags").select("menu_item_id").eq("status", "open").order("menu_item_id").range(from, to)
  );
  if (error) throw error;
  return [...new Set((data ?? []).map((r) => r.menu_item_id))];
}

// ── list ─────────────────────────────────────────────────────────────────────

export async function listManagerProducts(
  scope: ManagerScope,
  q: ProductQuery
): Promise<{ items: ProductListItem[]; nextCursor: string | null; counts: ProductCounts }> {
  const effective = narrowScope(scope, q.zone);
  const supabase = createAdminClient();
  const term = q.q ? searchTerm(q.q) : "";
  const flagged = q.flagged ? await openlyFlaggedIds() : null;

  const shared = (query: Q): Q => {
    let out = query;
    if (term) out = out.ilike("name", `%${term}%`);
    if (q.vendor) out = out.eq("restaurant_id", q.vendor);
    if (q.category) out = q.category === UNCATEGORISED ? out.is("category", null) : out.eq("category", q.category);
    return out;
  };

  let query = shared(inScope(supabase.from("menu_items").select(PRODUCT_COLUMNS), effective));
  if (q.availability === "available") query = query.eq("available", true);
  if (q.availability === "unavailable") query = query.eq("available", false);
  if (q.availability === "out_of_stock") query = query.or("sold_out_by_stock.eq.true,stock_qty.eq.0");
  if (q.availability === "low_stock") query = query.gt("stock_qty", 0).not("low_stock_at", "is", null);
  if (q.approval) query = query.eq("approval_status", q.approval);
  if (q.hidden) query = query.eq("hidden_by_ops", true);
  if (flagged) query = query.in("id", flagged.length > 0 ? flagged : ["00000000-0000-0000-0000-000000000000"]);
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

  const [flags, counts] = await Promise.all([openFlagCounts(page.map((r) => r.id)), productCounts(effective, shared)]);
  return { items: page.map((r) => toProductListItem(r, flags.get(r.id) ?? 0)), nextCursor, counts };
}

async function productCounts(scope: ManagerScope, shared: (q: Q) => Q): Promise<ProductCounts> {
  const supabase = createAdminClient();
  const head = () => shared(inScope(supabase.from("menu_items").select("id, restaurants!inner(zone_id)", { count: "exact", head: true }), scope));
  const n = async (q: Q) => {
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  };
  const tracked = await readAllRows<{ id: string; stock_qty: number | null; low_stock_at: number | null }>((from, to) =>
    shared(inScope(supabase.from("menu_items").select("id, stock_qty, low_stock_at, restaurants!inner(zone_id)"), scope))
      .gt("stock_qty", 0)
      .not("low_stock_at", "is", null)
      .order("id")
      .range(from, to) as never
  );
  if (tracked.error) throw tracked.error;
  const flagRows = await readAllRows<{ id: string }>((from, to) =>
    (inScope(supabase.from("listing_flags").select("id, restaurants!inner(zone_id)"), scope) as Q)
      .eq("status", "open")
      .order("id")
      .range(from, to) as never
  );
  if (flagRows.error) throw flagRows.error;
  const [unavailable, outOfStock, pendingApproval, hidden] = await Promise.all([
    n(head().eq("available", false)),
    n(head().or("sold_out_by_stock.eq.true,stock_qty.eq.0")),
    n(head().eq("approval_status", "pending")),
    n(head().eq("hidden_by_ops", true)),
  ]);
  return {
    unavailable,
    outOfStock,
    lowStock: (tracked.data ?? []).filter(isLowStock).length,
    pendingApproval,
    openFlags: (flagRows.data ?? []).length,
    hidden,
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
  const items = await readAllRows<ProductRow>((from, to) => {
    let q = inScope(supabase.from("menu_items").select(PRODUCT_COLUMNS), scope);
    if (vendor) q = q.eq("restaurant_id", vendor);
    return q.order("id").range(from, to) as never;
  });
  if (items.error) throw items.error;
  const rows = items.data ?? [];
  const ids = rows.map((r) => r.id);

  const zones = scopeZoneIds(scope);
  const [sales, changes, flags] = await Promise.all([
    supabase.rpc("ops_product_sales", {
      p_zone_ids: zones ? [...zones] : null, p_start: b.start.toISOString(), p_end: b.endExclusive.toISOString(), p_restaurant: vendor,
    }),
    // Every availability and price change since the range began: later changes
    // tell availabilityStats the state a dish was in during the range.
    readInChunks<{ menu_item_id: string; field: string; old_value: string | null; new_value: string | null; source: string; created_at: string }>(
      ids,
      (chunk) =>
        readAllRows((from, to) =>
          supabase
            .from("menu_item_changes")
            .select("id, menu_item_id, field, old_value, new_value, source, created_at")
            .in("menu_item_id", chunk)
            .in("field", ["available", "price"])
            .gte("created_at", b.start.toISOString())
            .order("id")
            .range(from, to)
        )
    ),
    openFlagCounts(ids),
  ]);
  if (sales.error) throw sales.error;
  if (changes.error) throw changes.error;
  const salesMap = new Map(
    ((sales.data ?? []) as { menu_item_id: string; units: number; revenue: number }[]).map((s) => [
      s.menu_item_id,
      { units: Number(s.units), revenue: Number(s.revenue) },
    ])
  );
  const all = changes.data ?? [];
  const insights = buildProductInsights({
    items: rows,
    sales: salesMap,
    availabilityChanges: all.filter((c) => c.field === "available").map((c) => ({ itemId: c.menu_item_id, at: c.created_at, to: c.new_value === "true" })),
    priceChanges: all.filter((c) => c.field === "price").map((c) => ({ itemId: c.menu_item_id, at: c.created_at, from: c.old_value, to: c.new_value, source: c.source })),
    range: b,
    limit,
    openFlags: flags,
  });
  return { from: range.from, to: range.to, ...insights };
}

/** For the actions route: the dish's restaurant if the scope may see it. */
export async function productRestaurant(scope: ManagerScope, id: string): Promise<string | null> {
  const row = await scopedProductRow(scope, id);
  return row?.restaurant_id ?? null;
}
