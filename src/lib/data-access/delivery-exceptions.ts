import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_ZONE, scopeAllows, type ManagerScope } from "@/lib/auth/manager-scope";
import { scopedRiderIds } from "@/lib/data-access/scoped-riders";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyDelivered } from "@/lib/notifications/order-events";
import { notifyUser } from "@/lib/notifications/notify-user";
import { cancelOrderAsOps } from "@/lib/data-access/order-cancellation";
import { recordCodForStaffDelivery } from "@/lib/data-access/driver-orders";
import { forceRiderOffline } from "@/lib/data-access/rider-status";
import { dispatchOrder } from "@/lib/dispatch/rider-dispatch";
import { loadPeople, namesFrom } from "@/lib/data-access/manager-riders";
import { encodeTimeCursor, type DeliveryException } from "@/lib/ops/rider-contract";
import { EXCEPTION_COLUMNS, serializeException, type ExceptionRow } from "@/lib/ops/rider-serialize";
import { mapExceptionError } from "@/lib/ops/exception-actions";
import type { OpsResult } from "@/lib/ops/order-actions";

/**
 * Delivery exceptions — the Rider plan's `delivery-exceptions.ts` (rider phase
 * 2 Task 4) decision side, created here first with its signature for the
 * Manager app, the web manager board and admin.
 *
 * A decision is two steps on purpose. The decision itself — the exception's
 * status, its `exception_decided` event and the audit row — is one RPC
 * (`ops_decide_delivery_exception`, 0152) and is never lost. What an approval
 * MEANS (fail the delivery and cancel the order, complete it without the code,
 * release it and take the rider offline) runs after, here, and every step
 * re-reads the current state first, so a retry finishes what is unfinished and
 * repeats nothing: no second cancellation, no second refund, no second COD
 * record. If a step throws, the answer is `effect_failed` and the same request
 * (same clientActionId) can simply be sent again.
 *
 * Callers authorise first (managerApiContext("manager.exceptions.decide"), or
 * requireRole for the web board / admin).
 */

type Actor = { id: string; role: "admin" | "manager" };
const FAILED_KINDS = new Set(["failed_delivery", "customer_unreachable", "wrong_address"]);

interface CurrentState {
  delivery: { id: string; status: string; driver_id: string | null; correction_reason: string | null } | null;
  orderStatus: string | null;
}

/** The delivery and order as they are now — every effect decides from this, never from the decision. */
async function currentState(deliveryId: string, orderId: string): Promise<CurrentState> {
  const supabase = createAdminClient();
  const [d, o] = await Promise.all([
    supabase.from("deliveries").select("id, status, driver_id, correction_reason").eq("id", deliveryId).maybeSingle(),
    supabase.from("orders").select("status").eq("id", orderId).maybeSingle(),
  ]);
  if (d.error) throw d.error;
  if (o.error) throw o.error;
  return {
    delivery: (d.data as CurrentState["delivery"]) ?? null,
    orderStatus: (o.data as { status: string } | null)?.status ?? null,
  };
}

interface Decided {
  exception_id: string;
  kind: string;
  delivery_id: string;
  order_id: string;
  driver_id: string;
  status: string;
  replayed: boolean;
}

/** The effects of an approved request. Idempotent: each step re-checks state. */
async function applyApproval(actor: Actor, d: Decided, reason: string): Promise<{ ok: true } | { ok: false; error: "already_resolved" }> {
  const supabase = createAdminClient();

  if (FAILED_KINDS.has(d.kind)) {
    let s = await currentState(d.delivery_id, d.order_id);
    if (s.delivery?.status === "delivered") return { ok: false, error: "already_resolved" };
    if (s.delivery && ["assigned", "picked_up"].includes(s.delivery.status)) {
      const { error } = await supabase
        .from("deliveries")
        .update({ status: "failed", failed_at: new Date().toISOString(), failure_reason: `${d.kind}: ${reason}`.slice(0, 300) })
        .eq("id", d.delivery_id)
        .in("status", ["assigned", "picked_up"]);
      if (error) throw error;
      s = await currentState(d.delivery_id, d.order_id);
    }
    if (s.orderStatus && s.orderStatus !== "cancelled" && s.orderStatus !== "delivered") {
      const res = await cancelOrderAsOps(d.order_id, { by: actor.role, reason: `delivery_failed: ${d.kind}`, requestedBy: actor.id });
      if (!res.ok) {
        // Someone else may have cancelled it meanwhile — that is the outcome wanted.
        const after = await currentState(d.delivery_id, d.order_id);
        if (after.orderStatus !== "cancelled") throw new Error(res.error);
      }
    }
    return { ok: true };
  }

  if (d.kind === "complete_without_code") {
    const s = await currentState(d.delivery_id, d.order_id);
    if (s.delivery?.status === "delivered") {
      await recordCodForStaffDelivery(d.order_id); // records only if not yet recorded
      return { ok: true };
    }
    if (!s.delivery || s.delivery.status !== "picked_up") return { ok: false, error: "already_resolved" };
    if (s.orderStatus === "on_the_way") {
      const { error } = await supabase.from("orders").update({ status: "delivered" }).eq("id", d.order_id).eq("status", "on_the_way");
      if (error) throw error;
    }
    const { error } = await supabase
      .from("deliveries")
      .update({ status: "delivered", delivered_at: new Date().toISOString(), delivery_method: "ops_approved" })
      .eq("id", d.delivery_id)
      .eq("status", "picked_up");
    if (error) throw error;
    if (!d.replayed) deferNotify(() => notifyDelivered(d.order_id));
    await recordCodForStaffDelivery(d.order_id);
    return { ok: true };
  }

  if (d.kind === "go_offline") {
    const s = await currentState(d.delivery_id, d.order_id);
    // Still this rider's job: hand it back to dispatch (a release is a correction, 0082 rule 6a).
    if (s.delivery && s.delivery.driver_id === d.driver_id && ["assigned", "picked_up"].includes(s.delivery.status)) {
      const { error } = await supabase
        .from("deliveries")
        .update({ driver_id: null, status: "unassigned", correction_reason: `go_offline approved ${new Date().toISOString()}` })
        .eq("id", d.delivery_id)
        .eq("driver_id", d.driver_id);
      if (error) throw error;
      const stage = s.orderStatus === "ready" ? "ready" : "accepted";
      await dispatchOrder(d.order_id, stage, { excludeRiderIds: [d.driver_id] });
    }
    await forceRiderOffline(d.driver_id, "ops");
    return { ok: true };
  }

  // manual_pickup: the rider now confirms the pickup with method `manual`.
  return { ok: true };
}

/** The rider hears the outcome. */
function notifyRider(d: Decided, decision: string, note: string | null) {
  const word = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "noted";
  return notifyUser({
    userId: d.driver_id,
    role: "rider",
    category: "exceptions",
    title: `Your request was ${word}`,
    body: note ?? (decision === "approve" ? "Ops approved your request." : decision === "reject" ? "Ops did not approve your request." : "Ops have seen your report."),
    url: `/jobs/${d.order_id}`,
    data: { exceptionId: d.exception_id, decision },
  });
}

export async function decideException(
  actor: Actor,
  id: string,
  decision: "approve" | "reject" | "acknowledge",
  note?: string,
  clientActionId?: string
): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_resolved" | "invalid_decision" | "note_required" | "effect_failed" }> {
  const { data, error } = await createAdminClient().rpc("ops_decide_delivery_exception", {
    p_actor: actor.id,
    p_exception: id,
    p_decision: decision,
    p_note: note?.trim() || null,
    p_client_action_id: clientActionId ?? crypto.randomUUID(),
  });
  if (error) {
    const mapped = mapExceptionError(error);
    if (mapped.ok) return { ok: false, error: "effect_failed" };
    if (mapped.status === 404) return { ok: false, error: "not_found" };
    if (mapped.error === "already_resolved") return { ok: false, error: "already_resolved" };
    if (mapped.error === "note_required") return { ok: false, error: "note_required" };
    if (mapped.error === "invalid_transition") return { ok: false, error: "invalid_decision" };
    return { ok: false, error: "effect_failed" };
  }
  const d = data as Decided;
  if (!d.replayed) deferNotify(() => notifyRider(d, decision, note?.trim() || null));
  if (d.status !== "approved") return { ok: true };
  try {
    return await applyApproval(actor, d, note?.trim() || d.kind);
  } catch {
    return { ok: false, error: "effect_failed" };
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * Exceptions raised by the riders who share one of the manager's zones
 * (0082 keeps no foreign key from an exception to its order, so the list is
 * scoped through the rider; single reads also check the order's zone, as the
 * decision RPC does). Pending: oldest first (the queue).
 */
export async function listExceptions(
  scope: ManagerScope,
  q: { status: DeliveryException["status"] | null; rider: string | null; cursor: { at: string; id: string } | null },
  viewerPerms: Record<string, boolean>
): Promise<{ items: DeliveryException[]; nextCursor: string | null; counts: { pending: number } }> {
  const supabase = createAdminClient();
  const scoped = await scopedRiderIds(scope);
  const riders = scoped === null ? null : scoped.size > 0 ? [...scoped] : [NO_ZONE];
  let page = supabase.from("delivery_exceptions").select(EXCEPTION_COLUMNS);
  let pending = supabase.from("delivery_exceptions").select("id", { count: "exact", head: true }).eq("status", "pending");
  if (riders) {
    page = page.in("driver_id", riders);
    pending = pending.in("driver_id", riders);
  }
  if (q.status) page = page.eq("status", q.status);
  if (q.rider) page = page.eq("driver_id", q.rider);
  const ascending = q.status === "pending";
  if (q.cursor) {
    page = ascending
      ? page.or(`created_at.gt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.gt.${q.cursor.id})`)
      : page.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  }
  const [{ data, error }, count] = await Promise.all([
    page.order("created_at", { ascending }).order("id", { ascending }).limit(51),
    pending,
  ]);
  if (error) throw error;
  if (count.error) throw count.error;
  const rows = (data ?? []) as unknown as ExceptionRow[];
  const page50 = rows.slice(0, 50);
  const names = namesFrom(await loadPeople(page50.flatMap((r) => [r.driver_id, r.decided_by])), new Map());
  const last = page50[page50.length - 1];
  return {
    items: page50.map((r) => serializeException(r, names, viewerPerms)),
    nextCursor: rows.length > 50 && last ? encodeTimeCursor(last.created_at, last.id) : null,
    counts: { pending: count.count ?? 0 },
  };
}

/** The exception row when its order is in the scope's zones, else null. */
async function scopedExceptionRow(scope: ManagerScope, id: string): Promise<ExceptionRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("delivery_exceptions").select(EXCEPTION_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  const row = data as unknown as ExceptionRow | null;
  if (!row) return null;
  if (scope.all) return row;
  const { data: order, error: oErr } = await supabase.from("orders").select("zone_id").eq("id", row.order_id).maybeSingle();
  if (oErr) throw oErr;
  return scopeAllows(scope, (order as { zone_id: string | null } | null)?.zone_id) ? row : null;
}

/** One exception in scope (the decide route's existence check and re-read). */
export async function getException(scope: ManagerScope, id: string, viewerPerms: Record<string, boolean>): Promise<DeliveryException | null> {
  const row = await scopedExceptionRow(scope, id);
  if (!row) return null;
  const names = namesFrom(await loadPeople([row.driver_id, row.decided_by]), new Map());
  return serializeException(row, names, viewerPerms);
}

/** A 60-second link to the exception's photo (delivery-proofs bucket), after the scope check. */
export async function exceptionPhotoUrl(scope: ManagerScope, id: string): Promise<{ url: string; expiresAt: string } | null> {
  const row = await scopedExceptionRow(scope, id);
  if (!row?.photo_path) return null;
  const { data: signed } = await createAdminClient().storage.from("delivery-proofs").createSignedUrl(row.photo_path, 60);
  if (!signed?.signedUrl) return null;
  return { url: signed.signedUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

export type { OpsResult };
