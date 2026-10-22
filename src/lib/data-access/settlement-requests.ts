import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyShop } from "@/lib/notifications/notify-user";
import { notifyPaymentDecided, notifyPaymentRequested } from "@/lib/notifications/payment-events";
import { createInstantDraft, createSettlementDraft, isDraftStale } from "@/lib/data-access/admin-settlements";
import { mapPaymentRpcError } from "@/lib/ops/payment-actions";
import { addDays, istDayKey } from "@/lib/metrics";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { InitiateSettlementInput, SettlementMethod } from "@/lib/ops/finance-contract";

/**
 * Vendor settlements through maker–checker (§7, migration 0156). There is no
 * one-person vendor payment path anywhere — not for managers, not for admins:
 *
 *   initiate → a DRAFT is built with the one settlement arithmetic
 *              (admin-settlements.ts) and put up for approval
 *              (ops_request_vendor_settlement);
 *   approve  → someone other than the requester approves with the
 *              transaction reference (ops_decide_payment_request), which marks
 *              the settlement paid in the same transaction as the audit row.
 *              If a refund made the draft stale since it was built, the draft
 *              is rebuilt under the same request (detach → rebuild → repoint)
 *              and the approver is asked to confirm the new amount.
 *
 * Callers authorise first (managerApiContext + switches, or requireRole admin)
 * and scope-check the shop; the RPCs check zone and role again.
 */

type Fail = Extract<OpsResult, { ok: false }>;
type Result<T> = { ok: true; value: T } | Fail;

const rpcFail = (error: { code?: string; message?: string; details?: string | null }): Fail => {
  const mapped = mapPaymentRpcError(error);
  return mapped.ok ? { ok: false, status: 500, error: "action_failed" } : mapped;
};

interface RequestState { request_id: string; status: string; amount: number; settlement_id: string | null; replayed: boolean }

/**
 * The same person sending the same action again (a retry after a timeout):
 * answer with what that first call did, before any check that would now
 * refuse it (already decided) or redo work (a draft rebuilt). Keyed by the
 * caller's own audit row, so another person's id never matches.
 */
async function replayedRequest(actorId: string, clientActionId: string, requestId?: string): Promise<RequestState | null> {
  const supabase = createAdminClient();
  const { data: row, error } = await supabase.from("ops_audit_log")
    .select("entity_type, entity_id").eq("client_action_id", clientActionId).eq("actor_id", actorId).maybeSingle();
  if (error) throw error;
  if (!row || row.entity_type !== "payment_request") return null;
  const id = requestId ?? (row.entity_id as string);
  if (requestId && row.entity_id !== requestId) return null;
  const { data: req, error: rErr } = await supabase.from("payment_requests")
    .select("id, status, amount, settlement_id").eq("id", id).maybeSingle();
  if (rErr) throw rErr;
  if (!req) return null;
  return { request_id: req.id as string, status: req.status as string, amount: Number(req.amount), settlement_id: (req.settlement_id as string | null) ?? null, replayed: true };
}

/**
 * May this person approve a request they made themselves? Only an admin, and
 * only while an admin has turned allow_single_admin_payments on (0152); the
 * RPC then still demands a reason.
 */
async function mayApproveOwn(actorId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const [{ data: who }, { data: settings }] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", actorId).maybeSingle(),
    supabase.from("platform_settings").select("allow_single_admin_payments").limit(1).maybeSingle(),
  ]);
  return who?.role === "admin" && settings?.allow_single_admin_payments === true;
}

/** The order a one-order payout is for: its shop, zone and state. */
async function orderForInitiation(orderId: string): Promise<{ restaurantId: string; zoneId: string | null } | null> {
  const { data, error } = await createAdminClient().from("orders")
    .select("restaurant_id, zone_id").eq("id", orderId).maybeSingle();
  if (error) throw error;
  return data ? { restaurantId: data.restaurant_id as string, zoneId: (data.zone_id as string | null) ?? null } : null;
}

/** Put an existing draft up for approval. */
export async function openSettlementRequest(
  actorId: string,
  settlementId: string,
  method: SettlementMethod,
  note: string | null,
  clientActionId: string
): Promise<Result<RequestState>> {
  const { data, error } = await createAdminClient().rpc("ops_request_vendor_settlement", {
    p_actor: actorId, p_settlement: settlementId, p_method: method, p_note: note, p_client_action_id: clientActionId,
  });
  if (error) return rpcFail(error);
  const state = data as RequestState;
  if (!state.replayed) deferNotify(() => notifyPaymentRequested(state.request_id));
  return { ok: true, value: state };
}

/**
 * Build the draft (a period, or one delivered order) and put it up for
 * approval. If the request cannot be opened the draft is voided again, so no
 * orphan draft holds the orders.
 */
export async function initiateVendorSettlement(
  actorId: string,
  input: InitiateSettlementInput
): Promise<Result<{ settlementId: string; requestId: string }>> {
  const replay = await replayedRequest(actorId, input.clientActionId);
  if (replay) return { ok: true, value: { settlementId: replay.settlement_id ?? "", requestId: replay.request_id } };

  // A one-order payout must be for an order of the shop the caller named (the
  // route checked that shop is in the caller's zones). Anything else is the
  // same not_found, so the answer says nothing about orders elsewhere.
  if (input.orderId) {
    const order = await orderForInitiation(input.orderId);
    if (!order || order.restaurantId !== input.vendorId) return { ok: false, status: 404, error: "not_found" };
  }

  const draft = input.orderId
    ? await createInstantDraft({ orderId: input.orderId, adminId: actorId })
    : await createSettlementDraft({ restaurantId: input.vendorId, fromDate: input.range!.from, toDate: input.range!.to, adminId: actorId, notes: input.note });
  if ("error" in draft) {
    const msg = draft.error;
    if (/No unsettled delivered orders/i.test(msg)) return { ok: false, status: 409, error: "nothing_to_pay" };
    if (/already been paid|in a settlement|settled elsewhere/i.test(msg)) return { ok: false, status: 409, error: "already_settled" };
    if (/Net is negative/i.test(msg)) return { ok: false, status: 409, error: "negative_net" };
    if (/not found|not delivered/i.test(msg)) return { ok: false, status: 404, error: "not_found" };
    return { ok: false, status: 409, error: "nothing_to_pay", extra: { message: msg } };
  }
  const opened = await openSettlementRequest(actorId, draft.id, input.method, input.note, input.clientActionId);
  if (!opened.ok) {
    await createAdminClient().rpc("ops_void_settlement", {
      p_actor: actorId, p_settlement: draft.id, p_reason: "The payment request could not be opened", p_client_action_id: `${input.clientActionId}:void`,
    });
    return opened;
  }
  return { ok: true, value: { settlementId: draft.id, requestId: opened.value.request_id } };
}

export interface ApproveInput {
  reference: string;
  paidOn: string | null;
  confirmAmount: number | null;
  note: string | null;
  clientActionId: string;
}

/**
 * Approve a vendor settlement request. Stale draft → rebuilt under the same
 * request and 409 `amount_changed` with the new amount and settlement id
 * (the approver re-sends `confirmAmount`); nothing left to pay → the request
 * is cancelled and 409 `nothing_to_pay`.
 */
export async function approveVendorSettlement(actorId: string, requestId: string, input: ApproveInput): Promise<Result<RequestState>> {
  const supabase = createAdminClient();
  // A retry of an approval that already went through answers with its result.
  const replay = await replayedRequest(actorId, input.clientActionId, requestId);
  if (replay) return { ok: true, value: replay };

  const { data: req, error: rErr } = await supabase
    .from("payment_requests").select("id, kind, status, settlement_id, subject_id, requested_by").eq("id", requestId).maybeSingle();
  if (rErr) throw rErr;
  if (!req || req.kind !== "vendor_settlement") return { ok: false, status: 404, error: "not_found" };
  if (req.status !== "pending_approval") return { ok: false, status: 409, error: "already_decided" };
  // The database refuses this too (same_person); answering before any rebuild
  // keeps a requester from voiding their own draft by "approving" it. The one
  // exception is the database's own: an admin under the one-admin switch.
  if (req.requested_by === actorId && !(await mayApproveOwn(actorId))) {
    return { ok: false, status: 403, error: "same_person" };
  }

  const settlementId = req.settlement_id as string | null;
  if (settlementId) {
    const check = await isDraftStale(settlementId);
    if (check.stale) {
      const rebuilt = await rebuildUnderRequest(actorId, requestId, settlementId, input.clientActionId);
      if (!rebuilt.ok) return rebuilt;
      return { ok: false, status: 409, error: "amount_changed", extra: { amount: rebuilt.value.amount, settlementId: rebuilt.value.settlementId } };
    }
  } else {
    // A rebuild that stopped half-way (detached, not yet repointed): finish it.
    const resumed = await resumeRebuild(actorId, requestId, input.clientActionId);
    if (!resumed.ok) return resumed;
    return { ok: false, status: 409, error: "amount_changed", extra: { amount: resumed.value.amount, settlementId: resumed.value.settlementId } };
  }

  const { data, error } = await supabase.rpc("ops_decide_payment_request", {
    p_actor: actorId, p_request: requestId, p_decision: "approve", p_reference: input.reference, p_paid_on: input.paidOn,
    p_confirm_amount: input.confirmAmount, p_note: input.note, p_client_action_id: input.clientActionId,
  });
  if (error) {
    // A refund landed between the check above and the payment: the database
    // caught it under the settlement lock. Rebuild, and ask the approver to
    // confirm the new amount.
    if ((error.message ?? "").trim() === "stale_draft" && settlementId) {
      const rebuilt = await rebuildUnderRequest(actorId, requestId, settlementId, `${input.clientActionId}:stale`);
      if (!rebuilt.ok) return rebuilt;
      return { ok: false, status: 409, error: "amount_changed", extra: { amount: rebuilt.value.amount, settlementId: rebuilt.value.settlementId } };
    }
    const fail = rpcFail(error);
    if (fail.error === "amount_changed") return { ...fail, extra: { ...(fail.extra ?? {}), settlementId } };
    return fail;
  }
  const state = data as RequestState;
  if (!state.replayed) {
    deferNotify(() => notifyPaymentDecided(requestId));
    deferNotify(() => notifyVendorPaid(settlementId!, input.reference));
  }
  return { ok: true, value: state };
}

/**
 * Ask for a PAID settlement to be reversed — the transfer did not reach the
 * vendor. Nothing changes until a different person approves the request
 * (ops_decide_payment_request), which voids the payout so its orders can be
 * paid again. A reason is required.
 */
export async function requestSettlementReversal(
  actorId: string,
  settlementId: string,
  reason: string,
  clientActionId: string
): Promise<Result<RequestState>> {
  const { data, error } = await createAdminClient().rpc("ops_request_settlement_reversal", {
    p_actor: actorId, p_settlement: settlementId, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) {
    const m = (error.message ?? "").trim();
    if (m === "not_paid") return { ok: false, status: 409, error: "not_paid" };
    if (m === "reason_required") return { ok: false, status: 400, error: "reason_required", extra: { field: "reason" } };
    return rpcFail(error);
  }
  const state = data as RequestState;
  if (!state.replayed) deferNotify(() => notifyPaymentRequested(state.request_id));
  return { ok: true, value: state };
}

interface Period { restaurantId: string; kind: string; from: string; to: string; orderId: string | null }

async function periodOf(settlementId: string): Promise<Period | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("vendor_settlements")
    .select("restaurant_id, kind, period_start, period_end").eq("id", settlementId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let orderId: string | null = null;
  if (data.kind === "instant") {
    const { data: line } = await supabase.from("vendor_settlement_orders").select("order_id").eq("settlement_id", settlementId).limit(1).maybeSingle();
    orderId = (line?.order_id as string | undefined) ?? null;
  }
  return {
    restaurantId: data.restaurant_id as string,
    kind: (data.kind as string) ?? "batch",
    from: istDayKey(data.period_start as string),
    to: addDays(istDayKey(data.period_end as string), -1),
    orderId,
  };
}

async function rebuildUnderRequest(actorId: string, requestId: string, oldSettlementId: string, cid: string): Promise<Result<{ amount: number; settlementId: string }>> {
  // Read what to rebuild BEFORE the old lines are deleted.
  const period = await periodOf(oldSettlementId);
  if (!period) return { ok: false, status: 404, error: "not_found" };
  const { error: dErr } = await createAdminClient().rpc("ops_detach_stale_settlement", {
    p_actor: actorId, p_request: requestId, p_client_action_id: `${cid}:detach`,
  });
  if (dErr) return rpcFail(dErr);
  return repointWithNewDraft(actorId, requestId, period, cid);
}

async function resumeRebuild(actorId: string, requestId: string, cid: string): Promise<Result<{ amount: number; settlementId: string }>> {
  // The detach audit row names the voided draft; rebuild the same period.
  const { data, error } = await createAdminClient().from("ops_audit_log")
    .select("after").eq("action", "payment.detach").eq("entity_id", requestId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const after = data?.after as { settlementId?: string; orderIds?: string[] } | null;
  if (!after?.settlementId) return { ok: false, status: 409, error: "rebuilding" };
  const period = await periodOf(after.settlementId);
  if (!period) return { ok: false, status: 409, error: "rebuilding" };
  // A voided one-order draft has no line left; the detach row kept its order.
  if (period.kind === "instant") period.orderId = after.orderIds?.[0] ?? null;
  if (period.kind === "instant" && !period.orderId) return { ok: false, status: 409, error: "rebuilding" };
  return repointWithNewDraft(actorId, requestId, period, `${cid}:resume`);
}

async function repointWithNewDraft(actorId: string, requestId: string, period: Period, cid: string): Promise<Result<{ amount: number; settlementId: string }>> {
  const draft = period.kind === "instant" && period.orderId
    ? await createInstantDraft({ orderId: period.orderId, adminId: actorId })
    : await createSettlementDraft({ restaurantId: period.restaurantId, fromDate: period.from, toDate: period.to, adminId: actorId, notes: "Rebuilt after a refund" });
  if ("error" in draft) {
    // Nothing left to settle in that period: no request stands.
    await createAdminClient().rpc("ops_decide_payment_request", {
      p_actor: actorId, p_request: requestId, p_decision: "reject", p_reference: null, p_paid_on: null, p_confirm_amount: null,
      p_note: "Nothing left to pay after a refund", p_client_action_id: `${cid}:reject`,
    });
    return { ok: false, status: 409, error: "nothing_to_pay" };
  }
  const { data, error } = await createAdminClient().rpc("ops_repoint_settlement_request", {
    p_actor: actorId, p_request: requestId, p_new_settlement: draft.id, p_client_action_id: `${cid}:repoint`,
  });
  if (error) return rpcFail(error);
  const state = data as RequestState;
  if (state.status === "cancelled") return { ok: false, status: 409, error: "nothing_to_pay" };
  return { ok: true, value: { amount: Number(state.amount), settlementId: draft.id } };
}

async function notifyVendorPaid(settlementId: string, reference: string): Promise<void> {
  const { data } = await createAdminClient().from("vendor_settlements").select("restaurant_id, net_payable").eq("id", settlementId).maybeSingle();
  if (!data) return;
  await notifyShop(data.restaurant_id as string, {
    category: "payments",
    title: "Payment sent 💸",
    body: `Deligro paid your settlement${data.net_payable != null ? ` of ₹${Number(data.net_payable).toLocaleString("en-IN")}` : ""}. Ref ${reference}.`,
    url: `/payments/${settlementId}`,
    data: { settlementId },
  });
}

// ── the admin console's paths (same RPCs, same rules) ─────────────────────

/** The pending request on a settlement, if any (for the admin screen's buttons). */
export async function pendingRequestFor(settlementId: string): Promise<{ id: string; kind: string; requestedBy: string; requestedByName: string; note: string | null } | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("payment_requests")
    .select("id, kind, requested_by, note").eq("settlement_id", settlementId).eq("status", "pending_approval").maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: who } = await supabase.from("profiles").select("full_name").eq("id", data.requested_by).maybeSingle();
  return {
    id: data.id as string,
    kind: data.kind as string,
    requestedBy: data.requested_by as string,
    requestedByName: (who?.full_name as string | null)?.trim() || "Staff",
    note: (data.note as string | null) ?? null,
  };
}

/** Whether this admin may approve their own requests (the one-admin switch). */
export async function adminMayApproveOwn(adminId: string): Promise<boolean> {
  return mayApproveOwn(adminId);
}

/**
 * Approve someone else's reversal request on a paid settlement (or, under the
 * one-admin switch, the admin's own, with a reason). Voids the payout so its
 * orders can be paid again; the database checks maker–checker.
 */
export async function approveSettlementReversal(
  actorId: string,
  requestId: string,
  note: string | null,
  clientActionId: string
): Promise<Result<RequestState>> {
  const { data, error } = await createAdminClient().rpc("ops_decide_payment_request", {
    p_actor: actorId, p_request: requestId, p_decision: "approve", p_reference: null, p_paid_on: null,
    p_confirm_amount: null, p_note: note, p_client_action_id: clientActionId,
  });
  if (error) {
    if ((error.message ?? "").trim() === "not_paid") return { ok: false, status: 409, error: "not_paid" };
    return rpcFail(error);
  }
  const state = data as RequestState;
  if (!state.replayed) deferNotify(() => notifyPaymentDecided(requestId));
  return { ok: true, value: state };
}

/**
 * Admin "Mark paid" on a draft: if nobody has asked for it yet, the admin puts
 * it up for approval (another admin, or a manager with approve_payment, then
 * pays it); if someone else asked, the admin approves it with the reference;
 * if the admin asked, they are told it needs someone else.
 */
export async function adminPayOrRequestSettlement(input: {
  settlementId: string;
  adminId: string;
  paymentRef: string;
  /** Required only when an admin approves their own request (one-admin switch). */
  note?: string | null;
}): Promise<{ ok: true; requested: boolean } | { error: string }> {
  const { data: pending, error } = await createAdminClient().from("payment_requests")
    .select("id, requested_by").eq("settlement_id", input.settlementId).eq("status", "pending_approval").maybeSingle();
  if (error) throw error;
  if (!pending) {
    const opened = await openSettlementRequest(input.adminId, input.settlementId, "bank", input.paymentRef.trim() ? `Reference to use: ${input.paymentRef.trim()}` : null, crypto.randomUUID());
    if (!opened.ok) return { error: adminMessage(opened.error) };
    return { ok: true, requested: true };
  }
  if (pending.requested_by === input.adminId && !(await mayApproveOwn(input.adminId))) {
    return { error: "You put this payment up for approval, so someone else must approve it — another admin, or a manager who can approve payments." };
  }
  if (pending.requested_by === input.adminId && (input.note ?? "").trim().length < 3) {
    return { error: "You're approving your own request under the one-admin setting: write a short reason." };
  }
  const ref = input.paymentRef.trim();
  if (!ref) return { error: "Enter the UTR / payment reference." };
  const res = await approveVendorSettlement(input.adminId, pending.id as string, {
    reference: ref, paidOn: null, confirmAmount: null, note: input.note?.trim() || null, clientActionId: crypto.randomUUID(),
  });
  if (!res.ok) {
    if (res.error === "amount_changed") {
      return { error: `A refund changed this settlement since it was built. It has been rebuilt at ₹${Number(res.extra?.amount ?? 0).toLocaleString("en-IN")}; open the new draft and approve that amount.` };
    }
    return { error: adminMessage(res.error) };
  }
  return { ok: true, requested: false };
}

/** Admin "Paid" on one order: a one-order draft, put up for approval. */
export async function adminRequestOrderPayout(input: { orderId: string; adminId: string }): Promise<{ id: string; requestId: string } | { error: string }> {
  const { data: order } = await createAdminClient().from("orders").select("restaurant_id").eq("id", input.orderId).maybeSingle();
  if (!order) return { error: "Order not found." };
  const res = await initiateVendorSettlement(input.adminId, {
    clientActionId: crypto.randomUUID(), vendorId: order.restaurant_id as string, range: null, orderId: input.orderId, method: "bank", note: null,
  });
  if (!res.ok) return { error: adminMessage(res.error) };
  return { id: res.value.settlementId, requestId: res.value.requestId };
}

function adminMessage(code: string): string {
  switch (code) {
    case "duplicate_pending": return "This shop already has a payment waiting for approval. Decide that one first.";
    case "nothing_to_pay": return "There is nothing to pay in that settlement.";
    case "negative_net": return "Net is negative (vendor owes the platform). Collect that separately — do not mark as paid out.";
    case "already_settled": return "This order has already been paid or is in a settlement.";
    case "same_person": return "You put this payment up for approval, so someone else must approve it.";
    case "not_draft": return "Only a draft settlement can be paid.";
    case "already_decided": return "This payment was already decided.";
    case "not_found": return "Settlement not found.";
    default: return "That didn't go through. Try again.";
  }
}
