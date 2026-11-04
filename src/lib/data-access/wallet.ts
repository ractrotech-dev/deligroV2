import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { getFeatures } from "@/lib/features/flags.server";
import { columnKnownMissing, isMissingColumn, rememberColumn } from "@/lib/data-access/schema-probe";
import { isRpcMissing } from "@/lib/manager/rpc-errors";
import { captureError } from "@/lib/obs/emit";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyWalletChangeAdded } from "@/lib/notifications/order-events";
import type { WalletKind } from "@/lib/wallet/money";

/**
 * The customer wallet's server side (0198). Every balance change is a database
 * function, one transaction, service role only. This module reads and calls them.
 *
 * ## Authorization
 *
 * Service role, so nothing here is safe to call without the caller's role check
 * (AGENTS.md rule 5): `customerId` comes from the session in /api/wallet and the
 * order routes, `riderId` from `requireRiderApi` / `requireDriver`, and `adminId`
 * from `requireRole("admin")`. The database functions then check that this person
 * owns this order or holds this delivery, so a wrong id gets a refusal, not a credit.
 *
 * ## `customer.wallet`
 *
 * The whole wallet sits behind `platform_settings.feature_wallet`. On top of that,
 * Admin → App features can turn it off for everyone or one customer: that is
 * `walletIsOnFor`, given the id from the customer's own session.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

export const WALLET_PAGE_SIZE = 30;

/** `orders.wallet_points_used` arrives with 0198. */
const POINTS_COLUMN = "orders.wallet_points_used";

export interface WalletMove {
  id: string;
  /** + credit, − debit, whole rupees. */
  amount: number;
  kind: WalletKind;
  reason: string;
  orderId: string | null;
  balanceAfter: number | null;
  at: string;
}

export interface MyWallet {
  /** Whether points can be added and used at all right now. */
  enabled: boolean;
  balance: number;
  moves: WalletMove[];
  nextCursor: string | null;
}

/** Is the wallet on for this customer? A failed read leaves it off. */
export async function walletIsOnFor(customerId: string): Promise<boolean> {
  const [platform, mine] = await Promise.all([
    walletIsOn(),
    getFeatures("customer", customerId)
      .then((f) => f["customer.wallet"] === true)
      .catch(() => false),
  ]);
  return platform && mine;
}

/** Is the wallet on for the platform? */
export async function walletIsOn(): Promise<boolean> {
  try {
    return (await getSettings()).featureWallet;
  } catch {
    return false;
  }
}

function toMove(r: {
  id: string;
  amount: number | string;
  kind?: string | null;
  reason: string;
  order_id: string | null;
  balance_after?: number | string | null;
  created_at: string;
}): WalletMove {
  return {
    id: r.id,
    amount: Number(r.amount),
    kind: (r.kind ?? "legacy") as WalletKind,
    reason: r.reason,
    orderId: r.order_id,
    balanceAfter: r.balance_after == null ? null : Number(r.balance_after),
    at: r.created_at,
  };
}

/** A customer's balance: 0 when it can't be read as anything else. Never a guess upward. */
export async function readWalletBalance(customerId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("profiles")
    .select("wallet_balance")
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw error;
  return Number((data as { wallet_balance?: number | string } | null)?.wallet_balance ?? 0);
}

/**
 * Balance and history, newest first. Keyset by `created_at`, because a new row
 * must not shift the pages the customer is scrolling through.
 */
export async function getMyWallet(
  customerId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<MyWallet> {
  const take = Math.min(Math.max(opts.limit ?? WALLET_PAGE_SIZE, 1), 100) + 1;
  const [enabled, balance] = await Promise.all([walletIsOnFor(customerId), readWalletBalance(customerId)]);

  const supabase = createAdminClient();
  const run = (columns: string) => {
    let query = supabase
      .from("wallet_transactions")
      .select(columns)
      .eq("user_id", customerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(take);
    if (opts.cursor) query = query.lt("created_at", opts.cursor);
    return query;
  };

  let result = await run("id, amount, kind, reason, order_id, balance_after, created_at");
  if (result.error && isMissingColumn(result.error)) {
    result = await run("id, amount, reason, order_id, created_at");
  }
  if (result.error) throw result.error;

  const rows = (result.data ?? []) as unknown as Parameters<typeof toMove>[0][];
  const hasMore = rows.length === take;
  const page = hasMore ? rows.slice(0, -1) : rows;
  return {
    enabled,
    balance,
    moves: page.map(toMove),
    nextCursor: hasMore ? (page.at(-1)?.created_at ?? null) : null,
  };
}

/**
 * Points used on each of these orders. Read on its own so a database without 0198
 * costs nothing: every order then has none, which is what it really has. Any other
 * failure throws: the answer decides how much cash a rider asks for, and "none" could
 * charge a customer twice.
 */
export async function readOrderPoints(
  supabase: AdminClient,
  orderIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0 || columnKnownMissing(POINTS_COLUMN)) return out;
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, wallet_points_used")
      .in("id", orderIds.slice(i, i + 200))
      .overrideTypes<{ id: string; wallet_points_used: number | null }[]>();
    if (error) {
      if (isMissingColumn(error)) {
        rememberColumn(POINTS_COLUMN, false);
        return out;
      }
      throw error;
    }
    rememberColumn(POINTS_COLUMN, true);
    for (const row of data ?? []) {
      if (row.wallet_points_used) out.set(row.id, Number(row.wallet_points_used));
    }
  }
  return out;
}

/** What the rider's door screen needs to know about adding change. */
export interface WalletChangeState {
  /** The wallet is on and this rider's `driver.cod_change` is on. */
  allowed: boolean;
  /** The most they can add on one order. */
  maxPerOrder: number;
  /** Already done on this delivery: what was received and what went to the wallet. */
  added: { change: number; received: number } | null;
}

/**
 * The rider's change state for one delivery. A failed read says "not allowed" and
 * nothing else: the rider can always finish the delivery the normal way.
 */
export async function walletChangeState(
  supabase: AdminClient,
  orderId: string,
  settings: { featureWallet: boolean; walletChangeMaxPerOrder: number },
  riderSwitchOn: boolean,
): Promise<WalletChangeState> {
  const base = {
    allowed: settings.featureWallet && riderSwitchOn,
    maxPerOrder: settings.walletChangeMaxPerOrder,
    added: null,
  };
  if (!settings.featureWallet) return base;
  try {
    const { data, error } = await supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("order_id", orderId)
      .eq("kind", "change_credit")
      .maybeSingle()
      .overrideTypes<{ amount: number | string }>();
    if (error) return { ...base, allowed: false };
    if (!data) return base;
    const { data: delivery } = await supabase
      .from("deliveries")
      .select("cod_collected_amount")
      .eq("order_id", orderId)
      .maybeSingle()
      .overrideTypes<{ cod_collected_amount: number | null }>();
    return {
      ...base,
      added: { change: Number(data.amount), received: Number(delivery?.cod_collected_amount ?? 0) },
    };
  } catch {
    return { ...base, allowed: false };
  }
}

export type IssueCodeResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; error: string };

/** A code for the customer's own cash delivery. Replaces any earlier one. */
export async function issueChangeCode(customerId: string, orderId: string): Promise<IssueCodeResult> {
  if (!(await walletIsOnFor(customerId))) return { ok: false, error: "wallet_off" };
  const { data, error } = await createAdminClient().rpc("wallet_issue_change_code", {
    p_customer: customerId,
    p_order: orderId,
  });
  if (error) {
    // Before 0198: the wallet doesn't exist, which is what the customer needs to hear.
    if (isRpcMissing(error)) return { ok: false, error: "wallet_off" };
    throw error;
  }
  const r = data as { ok: boolean; code?: string; expires_at?: string; error?: string };
  if (!r.ok || !r.code) return { ok: false, error: r.error ?? "server_error" };
  return { ok: true, code: r.code, expiresAt: r.expires_at ?? "" };
}

export type AddChangeResult =
  | { ok: true; change: number; received: number; replayed: boolean }
  | {
      ok: false;
      error: string;
      limit?: number;
      triesLeft?: number;
      cashDue?: number;
    };

/**
 * The rider's "add the change to the wallet". The database works out the change, checks
 * the code and the limit, and in one transaction credits, writes the ledger and records
 * the cash as the full amount received. The customer is told after the response, only
 * when this call did it.
 */
export async function addWalletChange(
  riderId: string,
  orderId: string,
  input: { received: number; code: string; actionId: string },
  opts: { notify?: (orderId: string, change: number) => Promise<unknown> } = {},
): Promise<AddChangeResult> {
  const { data, error } = await createAdminClient().rpc("wallet_add_change", {
    p_rider: riderId,
    p_order: orderId,
    p_received: input.received,
    p_code: input.code,
    p_client_action_id: input.actionId,
  });
  if (error) {
    if (isRpcMissing(error)) return { ok: false, error: "wallet_off" };
    throw error;
  }
  const r = data as {
    ok: boolean;
    error?: string;
    change?: number;
    received?: number;
    replayed?: boolean;
    limit?: number;
    tries_left?: number;
    cash_due?: number;
  };
  if (!r.ok) {
    return {
      ok: false,
      error: r.error ?? "server_error",
      limit: r.limit,
      triesLeft: r.tries_left,
      cashDue: r.cash_due,
    };
  }
  const change = Number(r.change ?? 0);
  if (!r.replayed) {
    const notify = opts.notify ?? notifyWalletChangeAdded;
    deferNotify(() => notify(orderId, change));
  }
  return { ok: true, change, received: Number(r.received ?? input.received), replayed: r.replayed === true };
}

export type SpendResult =
  | { ok: true; points: number; cashDue: number; replayed: boolean }
  | { ok: false; error: string; balance?: number };

/** Take the points for this order. One spend per order: a retry gets the first answer. */
export async function spendOnOrder(customerId: string, orderId: string, points: number): Promise<SpendResult> {
  const { data, error } = await createAdminClient().rpc("wallet_spend_on_order", {
    p_customer: customerId,
    p_order: orderId,
    p_points: points,
  });
  if (error) {
    if (isRpcMissing(error)) return { ok: false, error: "wallet_off" };
    captureError(error, { source: "wallet/spend", orderId, attrs: { event: "spend_failed" } });
    return { ok: false, error: "server_error" };
  }
  const r = data as { ok: boolean; error?: string; points?: number; cash_due?: number; replayed?: boolean; balance?: number | string };
  if (!r.ok) return { ok: false, error: r.error ?? "server_error", balance: r.balance === undefined ? undefined : Number(r.balance) };
  return { ok: true, points: Number(r.points ?? points), cashDue: Number(r.cash_due ?? 0), replayed: r.replayed === true };
}

export type CorrectResult = { ok: true; balance: number } | { ok: false; error: string };

/** An admin corrects a balance with a written reason. Audited in the function itself. */
export async function correctWallet(
  adminId: string,
  customerId: string,
  delta: number,
  reason: string,
  clientActionId: string,
): Promise<CorrectResult> {
  const { data, error } = await createAdminClient().rpc("wallet_admin_correct", {
    p_actor: adminId,
    p_customer: customerId,
    p_delta: delta,
    p_reason: reason,
    p_client_action_id: clientActionId,
  });
  if (error) throw error;
  const r = data as { ok: boolean; error?: string; balance?: number | string };
  if (!r.ok) return { ok: false, error: r.error ?? "server_error" };
  return { ok: true, balance: Number(r.balance ?? 0) };
}
