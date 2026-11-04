import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isRpcMissing } from "@/lib/manager/rpc-errors";
import { istDayStartIso, addDays } from "@/lib/rider/earnings-math";
import { customerSearchNeedle } from "@/lib/data-access/admin-customers";
import { formatDateTime } from "@/lib/utils/relative-time";
import type { WalletKind } from "@/lib/wallet/money";

/**
 * Admin → Customer wallets: what Deligro holds for customers, and every movement.
 *
 * Service role, so every page and action that calls this checks `requireRole("admin")`
 * first (AGENTS.md rule 5). Only reads: a balance moves through `wallet_admin_correct`.
 * Search, sort and paging run in the database, so they cover every customer.
 */

export interface WalletSummary {
  held: number;
  customers: number;
  addedThisMonth: number;
  usedThisMonth: number;
}

/** The headline figures, or null on a database without 0198. */
export async function getWalletSummary(): Promise<WalletSummary | null> {
  const { data, error } = await createAdminClient().rpc("ops_wallet_summary");
  if (error) {
    if (isRpcMissing(error)) return null;
    throw error;
  }
  const r = data as { held: number; customers: number; added_this_month: number; used_this_month: number };
  return {
    held: Number(r.held),
    customers: Number(r.customers),
    addedThisMonth: Number(r.added_this_month),
    usedThisMonth: Number(r.used_this_month),
  };
}

export type WalletSort = "balance" | "name" | "joined";

export interface WalletCustomerRow {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  joinedAt: string;
}

export async function listWalletCustomers(opts: {
  q?: string;
  sort?: WalletSort;
  withPoints?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: WalletCustomerRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 50) || 50));
  const from = (page - 1) * pageSize;

  let query = createAdminClient()
    .from("profiles")
    .select("id, full_name, phone, wallet_balance, created_at", { count: "exact" })
    .eq("role", "customer");
  if (opts.withPoints) query = query.gt("wallet_balance", 0);
  const needle = customerSearchNeedle(opts.q);
  if (needle) query = query.or(`full_name.ilike.${needle},phone.ilike.${needle}`);

  const sort = opts.sort ?? "balance";
  if (sort === "name") query = query.order("full_name", { ascending: true, nullsFirst: false });
  else if (sort === "joined") query = query.order("created_at", { ascending: false });
  else query = query.order("wallet_balance", { ascending: false });

  const { data, error, count } = await query.order("id", { ascending: true }).range(from, from + pageSize - 1);
  if (error) throw error;

  const rows = ((data ?? []) as {
    id: string;
    full_name: string | null;
    phone: string | null;
    wallet_balance: number | string;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    name: r.full_name?.trim() || "Customer",
    phone: r.phone,
    balance: Number(r.wallet_balance),
    joinedAt: formatDateTime(r.created_at),
  }));
  return { rows, total: count ?? 0, page, pageSize };
}

export interface WalletMovementRow {
  id: string;
  at: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  amount: number;
  kind: WalletKind;
  reason: string;
  orderId: string | null;
  balanceAfter: number | null;
  actorName: string;
  actorRole: string | null;
}

interface MovementRow {
  id: string;
  created_at: string;
  user_id: string;
  amount: number | string;
  kind: string;
  reason: string;
  order_id: string | null;
  balance_after: number | string | null;
  actor_role: string | null;
  customer: { full_name: string | null; phone: string | null } | { full_name: string | null; phone: string | null }[] | null;
  actor: { full_name: string | null } | { full_name: string | null }[] | null;
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** Who did it, for a row with no person behind it: a migration or the system. */
function actorName(r: MovementRow): string {
  const name = one(r.actor)?.full_name?.trim();
  if (name) return name;
  if (r.actor_role && r.actor_role !== "system") return r.actor_role;
  return "System";
}

/**
 * Every movement, newest first, filtered by type, person and IST date. A person is a
 * customer id (from their page) or a name or phone search.
 */
export async function listWalletMovements(opts: {
  kind?: WalletKind | null;
  customerId?: string | null;
  person?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: WalletMovementRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 50) || 50));
  const start = (page - 1) * pageSize;
  const needle = customerSearchNeedle(opts.person);

  // `!inner` so a search on the customer's name filters the movements, not just the embed.
  const embed = needle
    ? "customer:profiles!wallet_transactions_user_id_fkey!inner(full_name, phone)"
    : "customer:profiles!wallet_transactions_user_id_fkey(full_name, phone)";
  let query = createAdminClient()
    .from("wallet_transactions")
    .select(
      `id, created_at, user_id, amount, kind, reason, order_id, balance_after, actor_role, ${embed}, actor:profiles!wallet_transactions_actor_id_fkey(full_name)`,
      { count: "exact" },
    );
  if (opts.kind) query = query.eq("kind", opts.kind);
  if (opts.customerId) query = query.eq("user_id", opts.customerId);
  if (needle) {
    query = query.or(`full_name.ilike.${needle},phone.ilike.${needle}`, { referencedTable: "customer" });
  }
  if (opts.from) query = query.gte("created_at", istDayStartIso(opts.from));
  if (opts.to) query = query.lt("created_at", istDayStartIso(addDays(opts.to, 1)));

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(start, start + pageSize - 1);
  if (error) throw error;

  const rows = ((data ?? []) as unknown as MovementRow[]).map((r) => ({
    id: r.id,
    at: formatDateTime(r.created_at),
    customerId: r.user_id,
    customerName: one(r.customer)?.full_name?.trim() || "Customer",
    customerPhone: one(r.customer)?.phone ?? null,
    amount: Number(r.amount),
    kind: r.kind as WalletKind,
    reason: r.reason,
    orderId: r.order_id,
    balanceAfter: r.balance_after == null ? null : Number(r.balance_after),
    actorName: actorName(r),
    actorRole: r.actor_role,
  }));
  return { rows, total: count ?? 0, page, pageSize };
}

/** One customer's balance, for their page. Null on a database that can't answer. */
export async function getCustomerBalance(customerId: string): Promise<number | null> {
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("wallet_balance")
    .eq("id", customerId)
    .maybeSingle();
  if (error || !data) return null;
  return Number((data as { wallet_balance: number | string }).wallet_balance);
}
