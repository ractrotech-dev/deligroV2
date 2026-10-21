import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ManagerScope } from "@/lib/auth/manager-scope";
import type { ManagerApiContext } from "@/lib/auth/manager-api.server";
import { scopedRiderIds } from "@/lib/data-access/scoped-riders";
import { decideDepositRpc } from "@/lib/data-access/rider-cash";
import { loadPeople, namesFrom, riderVisible } from "@/lib/data-access/manager-riders";
import { encodeTimeCursor, type CashDeposit, type CashDispute } from "@/lib/ops/rider-contract";
import { mapPaymentRpcError } from "@/lib/ops/payment-actions";
import {
  CASH_DEPOSIT_COLUMNS,
  CASH_DISPUTE_COLUMNS,
  toCashDeposit,
  toCashDispute,
  type CashDepositRow,
  type CashDisputeRow,
} from "@/lib/ops/rider-serialize";
import type { OpsResult } from "@/lib/ops/order-actions";
import { NO_ZONE } from "@/lib/auth/manager-scope";

/**
 * Rider cash for managers (§5.14): deposits riders declared (confirm writes the
 * rider → manager handover; dispute needs a note the rider reads) and the
 * disputes riders raised. Every read is limited to the riders who share one of
 * the manager's zones.
 *
 * Callers authorise first (managerApiContext("manager.cash")).
 */

type Result<T> = { ok: true; value: T } | Extract<OpsResult, { ok: false }>;
const PAGE = 50;

/** `driver_id in (…)` for the scope's riders; null = an admin (no filter). */
async function riderFilter(scope: ManagerScope, rider: string | null): Promise<string[] | null> {
  if (rider) return (await riderVisible(scope, rider)) ? [rider] : [NO_ZONE];
  const ids = await scopedRiderIds(scope);
  if (ids === null) return null;
  return ids.size > 0 ? [...ids] : [NO_ZONE];
}

async function names(rows: { driver_id: string; decided_by?: string | null }[]) {
  return namesFrom(await loadPeople(rows.flatMap((r) => [r.driver_id, r.decided_by ?? null])), new Map(), false);
}

export async function listCashDeposits(
  scope: ManagerScope,
  q: { status: CashDeposit["status"] | null; rider: string | null; cursor: { at: string; id: string } | null }
): Promise<{ items: CashDeposit[]; nextCursor: string | null; counts: { submitted: number } }> {
  const ids = await riderFilter(scope, q.rider);
  const supabase = createAdminClient();
  let page = supabase.from("cash_deposits").select(CASH_DEPOSIT_COLUMNS);
  let submitted = supabase.from("cash_deposits").select("id", { count: "exact", head: true }).eq("status", "submitted");
  if (ids) {
    page = page.in("driver_id", ids);
    submitted = submitted.in("driver_id", ids);
  }
  if (q.status) page = page.eq("status", q.status);
  // Waiting deposits oldest first (the queue); decided ones newest first (history).
  const ascending = q.status === "submitted";
  if (q.cursor) {
    page = ascending
      ? page.or(`created_at.gt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.gt.${q.cursor.id})`)
      : page.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  }
  const [{ data, error }, count] = await Promise.all([
    page.order("created_at", { ascending }).order("id", { ascending }).limit(PAGE + 1),
    submitted,
  ]);
  if (error) throw error;
  if (count.error) throw count.error;
  const rows = (data ?? []) as CashDepositRow[];
  const n = await names(rows);
  const last = rows[PAGE - 1];
  return {
    items: rows.slice(0, PAGE).map((r) => toCashDeposit(r, n)),
    nextCursor: rows.length > PAGE && last ? encodeTimeCursor(last.created_at, last.id) : null,
    counts: { submitted: count.count ?? 0 },
  };
}

async function depositInScope(scope: ManagerScope, id: string): Promise<CashDepositRow | null> {
  const { data, error } = await createAdminClient().from("cash_deposits").select(CASH_DEPOSIT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  const row = data as CashDepositRow | null;
  if (!row || !(await riderVisible(scope, row.driver_id))) return null;
  return row;
}

export async function decideCashDeposit(
  ctx: ManagerApiContext,
  id: string,
  input: { clientActionId: string; decision: "confirm" | "dispute"; note: string | null }
): Promise<Result<CashDeposit>> {
  if (!(await depositInScope(ctx.scope, id))) return { ok: false, status: 404, error: "not_found" };
  const r = await decideDepositRpc(ctx.profile.id, id, input.decision, input.note, input.clientActionId);
  if (!r.ok) {
    const mapped = mapPaymentRpcError(r.error);
    return mapped.ok ? { ok: false, status: 500, error: "action_failed" } : mapped;
  }
  const row = await depositInScope(ctx.scope, id);
  if (!row) return { ok: false, status: 500, error: "action_failed" };
  return { ok: true, value: toCashDeposit(row, await names([row])) };
}

/** A 60-second link to the receipt photo the rider attached, after the scope check. */
export async function depositPhotoUrl(scope: ManagerScope, id: string): Promise<{ url: string; expiresAt: string } | null> {
  const row = await depositInScope(scope, id);
  if (!row?.photo_path) return null;
  const { data } = await createAdminClient().storage.from("delivery-proofs").createSignedUrl(row.photo_path, 60);
  if (!data?.signedUrl) return null;
  return { url: data.signedUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

export async function listCashDisputes(
  scope: ManagerScope,
  q: { status: CashDispute["status"] | null; cursor: { at: string; id: string } | null }
): Promise<{ items: CashDispute[]; nextCursor: string | null }> {
  const ids = await riderFilter(scope, null);
  let page = createAdminClient().from("cash_disputes").select(CASH_DISPUTE_COLUMNS);
  if (ids) page = page.in("driver_id", ids);
  if (q.status) page = page.eq("status", q.status);
  if (q.cursor) page = page.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  const { data, error } = await page.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE + 1);
  if (error) throw error;
  const rows = (data ?? []) as CashDisputeRow[];
  const n = await names(rows);
  const last = rows[PAGE - 1];
  return {
    items: rows.slice(0, PAGE).map((r) => toCashDispute(r, n)),
    nextCursor: rows.length > PAGE && last ? encodeTimeCursor(last.created_at, last.id) : null,
  };
}

export async function resolveCashDispute(
  ctx: ManagerApiContext,
  id: string,
  input: { clientActionId: string; resolution: string }
): Promise<Result<CashDispute>> {
  const supabase = createAdminClient();
  const read = async () => {
    const { data, error } = await supabase.from("cash_disputes").select(CASH_DISPUTE_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return data as CashDisputeRow | null;
  };
  const before = await read();
  if (!before || !(await riderVisible(ctx.scope, before.driver_id))) return { ok: false, status: 404, error: "not_found" };
  const { error } = await supabase.rpc("ops_resolve_cash_dispute", {
    p_actor: ctx.profile.id,
    p_dispute: id,
    p_resolution: input.resolution,
    p_client_action_id: input.clientActionId,
  });
  if (error) {
    const mapped = mapPaymentRpcError(error);
    return mapped.ok ? { ok: false, status: 500, error: "action_failed" } : mapped;
  }
  const after = await read();
  if (!after) return { ok: false, status: 500, error: "action_failed" };
  return { ok: true, value: toCashDispute(after, await names([after])) };
}
