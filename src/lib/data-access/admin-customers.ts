import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/utils/relative-time";
import { adminOrderStatus } from "@/lib/data-access/admin-orders";
import { shortOrderId } from "@/lib/utils/order-map";
import type { AdminOrderRow } from "@/lib/roles-data";

/**
 * Admin customers directory. Every signup lands in `public.profiles` (the
 * handle_new_user trigger on auth.users, see 0001_init), so this IS the live
 * list of people who have joined — ordered newest first, so a fresh
 * registration surfaces at the top with a "New" tag.
 *
 * Service-role client: an admin may read every profile (is_admin() in the RLS
 * policies), and we fold the per-customer order count into the same query. The
 * caller MUST already be admin-gated — the /admin layout's requireRole runs
 * before this does, and that gate is the authorization for the
 * createAdminClient() calls here (AGENTS.md §5).
 *
 * This is real customer PII on an operator's screen, so it is scoped to what a
 * support call actually needs: who they are, how to reach them, what they have
 * ordered, and what they have spent. Nothing here writes.
 */

const NEW_WINDOW_DAYS = 7;

export interface AdminCustomerRow {
  id: string;
  name: string;
  phone: string | null;
  orders: number;
  joinedAt: string; // human, e.g. "28 Jul, 2:14 PM"
  joinedAtIso: string; // raw timestamp, for any client-side formatting
  isNew: boolean; // joined within the last NEW_WINDOW_DAYS
}

interface Row {
  id: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  // PostgREST returns the aggregate embed as `[{ count }]`; tolerate both shapes.
  orders: { count: number }[] | { count: number } | null;
}

function orderCount(v: Row["orders"]): number {
  if (!v) return 0;
  return Array.isArray(v) ? (v[0]?.count ?? 0) : (v.count ?? 0);
}

export type CustomerFilter = "new" | "ordered";

export interface CustomerListOptions {
  q?: string;
  filter?: CustomerFilter | null;
  page?: number;
  pageSize?: number;
}

export interface CustomerListResult {
  rows: AdminCustomerRow[];
  /** Everyone matching the search and filter, not just this page. */
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomerFigures {
  total: number | null;
  newThisWeek: number | null;
  haveOrdered: number | null;
  /** All orders placed by customers, for the average per customer who has ordered. */
  orders: number | null;
}

/** Named FK: orders reaches profiles twice (customer_id and placed_by), and a bare embed is PGRST201. */
const ORDER_COUNT = "orders!orders_customer_id_fkey(count)";
/** `!inner` keeps only people with at least one order. */
const ORDER_COUNT_INNER = "orders!orders_customer_id_fkey!inner(count)";

const newCutoffIso = () => new Date(Date.now() - NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

/**
 * What a search term becomes inside PostgREST's or-filter, or null for nothing to
 * search. Commas and brackets would end the filter early and `%`/`*` would
 * widen it, so they become spaces. Pure so the check can run it bare.
 */
export function customerSearchNeedle(q: string | undefined): string | null {
  const cleaned = (q ?? "").replace(/[,()%*\\"]/g, " ").trim();
  return cleaned ? `*${cleaned}*` : null;
}

/**
 * One page of the customers directory, newest first, with the search and filter
 * run by the database, so they cover every customer and not just recent signups.
 */
export async function listCustomers(opts: CustomerListOptions = {}): Promise<CustomerListResult> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 50) || 50));
  const from = (page - 1) * pageSize;
  const embed = opts.filter === "ordered" ? ORDER_COUNT_INNER : ORDER_COUNT;

  let query = createAdminClient()
    .from("profiles")
    .select(`id, full_name, phone, created_at, ${embed}`, { count: "exact" })
    .eq("role", "customer");
  if (opts.filter === "new") query = query.gte("created_at", newCutoffIso());
  const needle = customerSearchNeedle(opts.q);
  if (needle) query = query.or(`full_name.ilike.${needle},phone.ilike.${needle}`);

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw error;

  const cutoff = Date.parse(newCutoffIso());
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    name: r.full_name?.trim() || "Customer",
    phone: r.phone,
    orders: orderCount(r.orders),
    joinedAt: formatDateTime(r.created_at),
    joinedAtIso: r.created_at,
    isNew: new Date(r.created_at).getTime() >= cutoff,
  }));
  return { rows, total: count ?? 0, page, pageSize };
}

/** Counts of every customer, for the figures above the list. A failed one is null, never 0. */
export async function getCustomerFigures(): Promise<CustomerFigures> {
  const db = createAdminClient();
  const customers = (select: string) =>
    db.from("profiles").select(select, { count: "exact", head: true }).eq("role", "customer");
  const [all, recent, ordered, orders] = await Promise.all([
    customers("id"),
    customers("id").gte("created_at", newCutoffIso()),
    customers(`id, ${ORDER_COUNT_INNER}`),
    db
      .from("orders")
      .select("id, profiles!orders_customer_id_fkey!inner(role)", { count: "exact", head: true })
      .eq("profiles.role", "customer"),
  ]);
  const read = (r: { count: number | null; error: unknown }) => (r.error ? null : r.count ?? 0);
  return { total: read(all), newThisWeek: read(recent), haveOrdered: read(ordered), orders: read(orders) };
}

/* ============================================================
   One customer
   ============================================================ */

/** A row in the customer's order history — enough to recognise it and open it. */
interface AdminCustomerOrderRow {
  id: string;
  code: string;
  restaurant: string;
  status: AdminOrderRow["status"];
  total: number;
  placedAt: string;
}

export interface AdminCustomerDetail {
  id: string;
  name: string;
  phone: string | null;
  /** 0151/0162: active, restricted (cannot order) or suspended (cannot sign in). "active" before 0151. */
  accountStatus: "active" | "restricted" | "suspended";
  statusReason: string | null;
  joinedAt: string;
  joinedAtIso: string;
  /** Every order they have ever placed, including cancelled ones. */
  orderCount: number;
  /**
   * Money from orders that actually arrived. Cancelled and in-flight orders are
   * deliberately excluded: a support call is not the place to quote someone a
   * lifetime figure that includes an order they never received.
   */
  lifetimeSpend: number;
  deliveredCount: number;
  /**
   * How many addresses they have saved. Null when the count could not be read
   * (a database predating 0006 has no `addresses` table) — shown as "—" rather
   * than as a confident zero.
   */
  savedAddresses: number | null;
  /** Newest first, capped — the full history is not what a support call needs. */
  orders: AdminCustomerOrderRow[];
}

/** Same reasoning as admin-orders: a malformed id is answered like a missing one. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OrderHistoryRow {
  id: string;
  status: string;
  total: number | null;
  created_at: string;
  restaurants: { name: string | null } | { name: string | null }[] | null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * One customer, for the operator on the phone to them.
 *
 * Scoped to `role = 'customer'` on purpose: this is the customers directory, and
 * the list it is reached from is scoped the same way. A vendor's or a rider's
 * profile id therefore 404s here rather than rendering an operator screen the
 * directory would never have linked to. (Converting a customer to a vendor
 * leaves their role as `customer` — see attachVendorToExistingUser — so a shop
 * owner who also shops is still found.)
 *
 * Returns null for an id that does not exist, one that isn't a uuid, and one
 * that belongs to a non-customer: all the same answer, so this never confirms
 * that an id exists somewhere else in the system.
 */
export async function getCustomerDetail(
  id: string,
  orderLimit = 25
): Promise<AdminCustomerDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const supabase = createAdminClient();

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, full_name, phone, created_at")
    .eq("id", id)
    .eq("role", "customer")
    .maybeSingle();

  if (error) throw error;
  if (!profile) return null;

  // A separate read so a database without 0151's columns still shows the page.
  const { data: statusRow } = await supabase.from("profiles").select("account_status, status_reason").eq("id", id).maybeSingle();
  const st = (statusRow as { account_status?: string; status_reason?: string | null } | null) ?? null;
  const accountStatus: AdminCustomerDetail["accountStatus"] =
    st?.account_status === "restricted" || st?.account_status === "suspended" ? st.account_status : "active";

  const [history, delivered, totalCount, addresses] = await Promise.all([
    supabase
      .from("orders")
      .select("id, status, total, created_at, restaurants(name)")
      .eq("customer_id", id)
      .order("created_at", { ascending: false })
      .limit(orderLimit),
    // Spend is summed over every delivered order, not just the page above —
    // "lifetime" has to mean lifetime or it should not be on the screen.
    supabase
      .from("orders")
      .select("total")
      .eq("customer_id", id)
      .eq("status", "delivered"),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", id),
    supabase
      .from("addresses")
      .select("id", { count: "exact", head: true })
      .eq("user_id", id),
  ]);

  const deliveredRows = (delivered.data ?? []) as { total: number | null }[];
  const rows = (history.data ?? []) as unknown as OrderHistoryRow[];

  return {
    id: profile.id,
    name: profile.full_name?.trim() || "Customer",
    phone: profile.phone?.trim() || null,
    accountStatus,
    statusReason: st?.status_reason ?? null,
    joinedAt: formatDateTime(profile.created_at),
    joinedAtIso: profile.created_at,
    orderCount: totalCount.count ?? rows.length,
    lifetimeSpend: deliveredRows.reduce((sum, o) => sum + Number(o.total ?? 0), 0),
    deliveredCount: deliveredRows.length,
    // A failed count is not zero. `addresses` arrived in 0006, and an operator
    // told "0 saved addresses" about someone with four would go looking for a
    // bug that isn't there.
    savedAddresses: addresses.error ? null : (addresses.count ?? 0),
    orders: rows.map((r) => ({
      id: r.id,
      code: `#${shortOrderId(r.id)}`,
      restaurant: one(r.restaurants)?.name ?? "—",
      status: adminOrderStatus(r.status),
      total: Number(r.total ?? 0),
      placedAt: formatDateTime(r.created_at),
    })),
  };
}
