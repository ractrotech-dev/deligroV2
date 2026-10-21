import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ManagerScope } from "@/lib/auth/manager-scope";
import type { ManagerApiContext } from "@/lib/auth/manager-api.server";
import { riderZoneFilter } from "@/lib/data-access/scoped-riders";
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

/**
 * Where a queue reads from. A zone-scoped manager reads the 0153 view, whose
 * rows carry their rider's zone ids, and filters by the manager's zones in the
 * database — never a URL of every rider id in those zones. An admin reads the
 * base table. One rider asked for by id is checked for visibility first.
 */
async function queueSource(
  scope: ManagerScope,
  base: "cash_deposits" | "cash_disputes",
  rider: string | null
): Promise<{ table: string; zones: string[] | null; rider: string | null }> {
  const zones = riderZoneFilter(scope);
  const table = zones === null ? base : `ops_${base}_scoped`;
  if (rider && !(await riderVisible(scope, rider))) return { table, zones, rider: NO_ZONE };
  return { table, zones, rider };
}

async function names(rows: { driver_id: string; decided_by?: string | null }[]) {
  return namesFrom(await loadPeople(rows.flatMap((r) => [r.driver_id, r.decided_by ?? null])), new Map(), false);
}

export async function listCashDeposits(
  scope: ManagerScope,
  q: { status: CashDeposit["status"] | null; rider: string | null; cursor: { at: string; id: string } | null }
): Promise<{ items: CashDeposit[]; nextCursor: string | null; counts: { submitted: number } }> {
  const src = await queueSource(scope, "cash_deposits", q.rider);
  const supabase = createAdminClient();
  let page = supabase.from(src.table).select(CASH_DEPOSIT_COLUMNS);
  let submitted = supabase.from(src.table).select("id", { count: "exact", head: true }).eq("status", "submitted");
  if (src.zones) {
    page = page.overlaps("rider_zone_ids", src.zones);
    submitted = submitted.overlaps("rider_zone_ids", src.zones);
  }
  if (src.rider) {
    page = page.eq("driver_id", src.rider);
    submitted = submitted.eq("driver_id", src.rider);
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
): Promise<{ items: CashDispute[]; nextCursor: string | null; counts: { open: number; resolved: number } }> {
  const src = await queueSource(scope, "cash_disputes", null);
  const supabase = createAdminClient();
  let page = supabase.from(src.table).select(CASH_DISPUTE_COLUMNS);
  const counted = (status: "open" | "resolved") => {
    let c = supabase.from(src.table).select("id", { count: "exact", head: true }).eq("status", status);
    if (src.zones) c = c.overlaps("rider_zone_ids", src.zones);
    return c;
  };
  if (src.zones) page = page.overlaps("rider_zone_ids", src.zones);
  if (q.status) page = page.eq("status", q.status);
  if (q.cursor) page = page.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  const [{ data, error }, open, resolved] = await Promise.all([
    page.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE + 1),
    counted("open"),
    counted("resolved"),
  ]);
  if (error) throw error;
  if (open.error) throw open.error;
  if (resolved.error) throw resolved.error;
  const rows = (data ?? []) as CashDisputeRow[];
  const n = await names(rows);
  const last = rows[PAGE - 1];
  return {
    items: rows.slice(0, PAGE).map((r) => toCashDispute(r, n)),
    nextCursor: rows.length > PAGE && last ? encodeTimeCursor(last.created_at, last.id) : null,
    counts: { open: open.count ?? 0, resolved: resolved.count ?? 0 },
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
