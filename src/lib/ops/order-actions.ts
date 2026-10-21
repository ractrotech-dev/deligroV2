/**
 * The body of `POST /api/manager/orders/[id]/actions`, the permission each
 * action needs, and how an intervention RPC's error becomes the pinned HTTP
 * answer. Pure.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import type { DbOrderStatus } from "./order-contract";

export type OrderActionName = "advance" | "cancel" | "assign" | "reassign" | "escalate" | "correct" | "note";
export type CorrectionKind = "status" | "delivery_status" | "item_unavailable" | "address_note";

/**
 * `override` on assign/reassign: put a rider on whom the picker marks
 * offline, on a break or without a fresh fix (src/lib/dispatch/eligibility.ts
 * canOverride) — never another zone or a suspended rider. Needs a reason.
 */
export type ParsedAction =
  | { action: "advance"; expected: DbOrderStatus; reason: string; clientActionId: string }
  | { action: "cancel"; reason: string; clientActionId: string }
  | { action: "assign"; riderId: string; reason: string | null; override: boolean; clientActionId: string }
  | { action: "reassign"; riderId: string; afterPickup: boolean; reason: string; override: boolean; clientActionId: string }
  | { action: "escalate"; priority: "high" | "emergency"; reason: string; clientActionId: string }
  | { action: "correct"; kind: CorrectionKind; toStatus?: string; itemId?: string; note?: string; reason: string; clientActionId: string }
  | { action: "note"; note: string; clientActionId: string };

/** The switch each action needs (design §Permissions; plan Global Constraints). */
export const ACTION_PERMISSION: Record<OrderActionName, string> = {
  advance: "manager.move_status",
  cancel: "manager.move_status",
  assign: "manager.assign_rider",
  reassign: "manager.reassign_rider",
  escalate: "manager.orders.escalate",
  correct: "manager.orders.correct",
  note: "manager.orders.correct",
};

const ORDER_STATUSES = ["placed", "kitchen", "ready", "on_the_way", "delivered", "cancelled"];
const DELIVERY_STATUSES = ["unassigned", "assigned", "picked_up", "delivered", "failed", "cancelled"];

type Fail = { ok: false; status: 400; error: "bad_request" | "reason_required"; field?: string };
const bad = (field: string): Fail => ({ ok: false, status: 400, error: "bad_request", field });
const needReason: Fail = { ok: false, status: 400, error: "reason_required" };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A required reason: 3–300 characters after trimming. */
function reasonOf(v: unknown): string | null {
  const t = text(v);
  return t && t.length >= 3 && t.length <= 300 ? t : null;
}

export function parseActionBody(body: Record<string, unknown> | null): { ok: true; action: ParsedAction } | Fail {
  if (!body) return bad("body");
  const action = body.action;
  if (typeof action !== "string" || !(action in ACTION_PERMISSION)) return bad("action");
  const clientActionId = body.clientActionId;
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) return bad("clientActionId");
  const optionalReason = text(body.reason);
  if (optionalReason !== null && optionalReason.length > 300) return needReason;

  switch (action as OrderActionName) {
    case "advance": {
      // Every status change a manager makes carries a reason (design §6.10);
      // the app offers quick picks so it costs one tap.
      const expected = body.expected;
      if (typeof expected !== "string" || !ORDER_STATUSES.includes(expected)) return bad("expected");
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return { ok: true, action: { action: "advance", expected: expected as DbOrderStatus, reason, clientActionId } };
    }
    case "cancel": {
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return { ok: true, action: { action: "cancel", reason, clientActionId } };
    }
    case "assign": {
      if (typeof body.riderId !== "string" || !isUuid(body.riderId)) return bad("riderId");
      if (body.override !== undefined && typeof body.override !== "boolean") return bad("override");
      const override = body.override === true;
      if (override && !reasonOf(body.reason)) return needReason;
      return { ok: true, action: { action: "assign", riderId: body.riderId, reason: optionalReason, override, clientActionId } };
    }
    case "reassign": {
      if (typeof body.riderId !== "string" || !isUuid(body.riderId)) return bad("riderId");
      if (body.afterPickup !== undefined && typeof body.afterPickup !== "boolean") return bad("afterPickup");
      if (body.override !== undefined && typeof body.override !== "boolean") return bad("override");
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return {
        ok: true,
        action: { action: "reassign", riderId: body.riderId, afterPickup: body.afterPickup === true, reason, override: body.override === true, clientActionId },
      };
    }
    case "escalate": {
      const priority = body.priority ?? "high";
      if (priority !== "high" && priority !== "emergency") return bad("priority");
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      return { ok: true, action: { action: "escalate", priority, reason, clientActionId } };
    }
    case "correct": {
      const kind = body.kind;
      if (kind !== "status" && kind !== "delivery_status" && kind !== "item_unavailable" && kind !== "address_note") return bad("kind");
      const reason = reasonOf(body.reason);
      if (!reason) return needReason;
      if (kind === "address_note") {
        const note = text(body.note);
        if (!note || note.length < 3 || note.length > 300) return bad("note");
        return { ok: true, action: { action: "correct", kind, note, reason, clientActionId } };
      }
      if (kind === "item_unavailable") {
        if (typeof body.itemId !== "string" || !isUuid(body.itemId)) return bad("itemId");
        return { ok: true, action: { action: "correct", kind, itemId: body.itemId, reason, clientActionId } };
      }
      const allowed = kind === "status" ? ORDER_STATUSES : DELIVERY_STATUSES;
      if (typeof body.toStatus !== "string" || !allowed.includes(body.toStatus)) return bad("toStatus");
      return { ok: true, action: { action: "correct", kind, toStatus: body.toStatus, reason, clientActionId } };
    }
    case "note": {
      const note = text(body.note);
      if (!note || note.length < 3 || note.length > 1000) return needReason;
      return { ok: true, action: { action: "note", note, clientActionId } };
    }
  }
}

export type OpsResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string; extra?: Record<string, unknown> };

const CONFLICTS = new Set([
  "stale", "already_assigned", "picked_up", "terminal", "financially_closed", "invalid_transition",
  "use_advance", "refund_exceeds_total",
]);

/** An intervention RPC's raised error → the pinned HTTP answer. */
export function mapRpcError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  if (message === "forbidden" || e.code === "42501") return { ok: false, status: 404, error: "not_found" };
  if (message === "reason_required") return { ok: false, status: 400, error: "reason_required" };
  if (message === "rider_ineligible") {
    return { ok: false, status: 409, error: "rider_ineligible", extra: { reasons: [e.details || "offline"] } };
  }
  // Someone else's client action id: the order may have moved on; refresh.
  if (message === "client_action_id_conflict") return { ok: false, status: 409, error: "stale" };
  if (CONFLICTS.has(message)) return { ok: false, status: 409, error: message };
  // 0081's delivery state machine refusing a move: a conflict, not a failure.
  if (message === "invalid_delivery_transition" || e.code === "23514") return { ok: false, status: 409, error: "invalid_transition" };
  // The unique delivery per order: a rider claimed it at the same moment.
  if (e.code === "23505") return { ok: false, status: 409, error: "already_assigned" };
  return { ok: false, status: 500, error: "action_failed" };
}
