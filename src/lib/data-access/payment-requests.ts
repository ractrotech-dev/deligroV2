import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import type { ManagerApiContext } from "@/lib/auth/manager-api.server";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyPaymentDecided, notifyPaymentRequested } from "@/lib/notifications/payment-events";
import { loadPeople, loadZoneNames, namesFrom, riderVisible, viewerOf } from "@/lib/data-access/manager-riders";
import { encodeTimeCursor } from "@/lib/ops/rider-contract";
import type { PaymentRequest } from "@/lib/ops/rider-contract";
import { mapPaymentRpcError, type DecideInput, type PayoutRequestInput } from "@/lib/ops/payment-actions";
import { withPaymentSettings } from "@/lib/data-access/payment-approvals";
import { PAYMENT_REQUEST_COLUMNS, toPaymentRequest, type PaymentRequestRow, type Viewer } from "@/lib/ops/rider-serialize";
import type { OpsResult } from "@/lib/ops/order-actions";

/**
 * Maker–checker payment requests (§5.13, §7): list, create (rider payouts),
 * decide. The database refuses the same person on both sides (0152); this
 * layer scopes reads to the manager's zones and sends the notices.
 *
 * Callers authorise first (managerApiContext + the decision's switch).
 */

export interface PaymentRequestQuery {
  status: PaymentRequest["status"] | null;
  kind: PaymentRequest["kind"] | null;
  zone: string | null;
  mine: boolean;
  cursor: { at: string; id: string } | null;
}

const STATUSES: PaymentRequest["status"][] = ["pending_approval", "approved", "rejected", "cancelled"];

async function serialize(rows: PaymentRequestRow[], who: Viewer): Promise<PaymentRequest[]> {
  // An admin may decide their own request only under the one-admin switch.
  const viewer = await withPaymentSettings(who);
  const people = await loadPeople(rows.flatMap((r) => [r.subject_id, r.requested_by, r.decided_by]));
  const zones = await loadZoneNames(rows.map((r) => r.zone_id));
  const names = namesFrom(people, zones, false);
  return rows.map((r) => toPaymentRequest(r, names, viewer));
}

export async function listPaymentRequests(
  scope: ManagerScope,
  viewer: Viewer,
  q: PaymentRequestQuery
): Promise<{ items: PaymentRequest[]; nextCursor: string | null; counts: Record<PaymentRequest["status"], number> }> {
  const s = q.zone ? narrowScope(scope, q.zone) : scope;
  const supabase = createAdminClient();
  // scopeZoneIds, not applyZoneScope: this builder's type is too deep for the generic.
  const zones = scopeZoneIds(s);
  const base = () => {
    let query = supabase.from("payment_requests").select(PAYMENT_REQUEST_COLUMNS);
    if (zones) query = query.in("zone_id", [...zones]);
    if (q.kind) query = query.eq("kind", q.kind);
    if (q.mine) query = query.eq("requested_by", viewer.id);
    return query;
  };
  let page = base().order("requested_at", { ascending: false }).order("id", { ascending: false }).limit(51);
  if (q.status) page = page.eq("status", q.status);
  if (q.cursor) page = page.or(`requested_at.lt.${q.cursor.at},and(requested_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  const counted = (status: string) => {
    let c = supabase.from("payment_requests").select("id", { count: "exact", head: true }).eq("status", status);
    if (zones) c = c.in("zone_id", [...zones]);
    if (q.kind) c = c.eq("kind", q.kind);
    if (q.mine) c = c.eq("requested_by", viewer.id);
    return c;
  };
  const [{ data, error }, ...counts] = await Promise.all([page, ...STATUSES.map(counted)]);
  if (error) throw error;
  for (const c of counts) if (c.error) throw c.error;
  const rows = (data ?? []) as PaymentRequestRow[];
  const items = await serialize(rows.slice(0, 50), viewer);
  const last = rows[49];
  return {
    items,
    nextCursor: rows.length > 50 && last ? encodeTimeCursor(last.requested_at, last.id) : null,
    counts: Object.fromEntries(STATUSES.map((st, i) => [st, counts[i].count ?? 0])) as Record<PaymentRequest["status"], number>,
  };
}

/** One request in scope, or null. */
export async function getPaymentRequest(scope: ManagerScope, id: string, viewer: Viewer): Promise<PaymentRequest | null> {
  const zones = scopeZoneIds(scope);
  let query = createAdminClient().from("payment_requests").select(PAYMENT_REQUEST_COLUMNS).eq("id", id);
  if (zones) query = query.in("zone_id", [...zones]);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await serialize([data as unknown as PaymentRequestRow], viewer))[0];
}

type Result<T> = { ok: true; value: T } | Extract<OpsResult, { ok: false }>;

export async function createRiderPayoutRequest(ctx: ManagerApiContext, input: PayoutRequestInput): Promise<Result<PaymentRequest>> {
  if (!(await riderVisible(ctx.scope, input.riderId))) return { ok: false, status: 404, error: "not_found" };
  const { data, error } = await createAdminClient().rpc("ops_request_rider_payout", {
    p_actor: ctx.profile.id,
    p_rider: input.riderId,
    p_period_end: input.periodEnd,
    p_method: input.method,
    p_salary: input.salaryAmount,
    p_note: input.note,
    p_client_action_id: input.clientActionId,
  });
  if (error) {
    const mapped = mapPaymentRpcError(error);
    return mapped.ok ? { ok: false, status: 500, error: "action_failed" } : mapped;
  }
  const state = data as { request_id: string; replayed: boolean };
  if (!state.replayed) deferNotify(() => notifyPaymentRequested(state.request_id));
  const request = await getPaymentRequest(ctx.scope, state.request_id, viewerOf(ctx));
  return request ? { ok: true, value: request } : { ok: false, status: 500, error: "action_failed" };
}

export async function decidePaymentRequest(ctx: ManagerApiContext, id: string, input: DecideInput): Promise<Result<PaymentRequest>> {
  if (!(await getPaymentRequest(ctx.scope, id, viewerOf(ctx)))) return { ok: false, status: 404, error: "not_found" };
  const { data, error } = await createAdminClient().rpc("ops_decide_payment_request", {
    p_actor: ctx.profile.id,
    p_request: id,
    p_decision: input.decision,
    p_reference: input.reference,
    p_paid_on: input.paidOn,
    p_confirm_amount: input.confirmAmount,
    p_note: input.note,
    p_client_action_id: input.clientActionId,
  });
  if (error) {
    const mapped = mapPaymentRpcError(error);
    return mapped.ok ? { ok: false, status: 500, error: "action_failed" } : mapped;
  }
  if ((data as { replayed?: boolean } | null)?.replayed !== true) deferNotify(() => notifyPaymentDecided(id));
  const request = await getPaymentRequest(ctx.scope, id, viewerOf(ctx));
  return request ? { ok: true, value: request } : { ok: false, status: 500, error: "action_failed" };
}
