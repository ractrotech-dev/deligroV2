/**
 * Bodies of the payout-request, deposit and dispute routes, and how their RPC
 * errors become the pinned answers (Phase 5 plan, API contract). Pure.
 *
 * Maker–checker is enforced by the database (0152): the same person can never
 * request and decide. These parsers only make sure what reaches it is whole.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { mapRpcError, type OpsResult } from "./order-actions";
import { isDay } from "./rider-actions";

type Fail = { ok: false; status: 400; error: string; field?: string };
const bad = (field: string): Fail => ({ ok: false, status: 400, error: "bad_request", field });
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Today in India, "YYYY-MM-DD". */
export function istToday(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const METHODS = ["bank", "upi", "cash", "other"] as const;
export type PayoutMethod = (typeof METHODS)[number];

export interface PayoutRequestInput {
  clientActionId: string;
  riderId: string;
  periodEnd: string;
  method: PayoutMethod;
  salaryAmount: number | null;
  note: string | null;
}

export function parsePayoutRequestBody(body: Record<string, unknown> | null, now: Date): { ok: true; input: PayoutRequestInput } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  // vendor_settlement requests arrive in Phase 6.
  if (body.kind !== "rider_payout") return bad("kind");
  if (typeof body.riderId !== "string" || !isUuid(body.riderId)) return bad("riderId");
  if (!isDay(body.periodEnd) || body.periodEnd > istToday(now)) return bad("periodEnd");
  if (typeof body.method !== "string" || !METHODS.includes(body.method as PayoutMethod)) return bad("method");
  let salaryAmount: number | null = null;
  if (body.salaryAmount !== undefined && body.salaryAmount !== null) {
    if (typeof body.salaryAmount !== "number" || !Number.isFinite(body.salaryAmount) || body.salaryAmount <= 0 || body.salaryAmount > 1_000_000) {
      return bad("salaryAmount");
    }
    salaryAmount = Math.round(body.salaryAmount * 100) / 100;
  }
  const note = text(body.note);
  if (note && note.length > 300) return bad("note");
  return {
    ok: true,
    input: { clientActionId: body.clientActionId, riderId: body.riderId.toLowerCase(), periodEnd: body.periodEnd, method: body.method as PayoutMethod, salaryAmount, note },
  };
}

export interface DecideInput {
  clientActionId: string;
  decision: "approve" | "reject" | "cancel";
  reference: string | null;
  paidOn: string | null;
  confirmAmount: number | null;
  note: string | null;
}

export function parseDecideBody(body: Record<string, unknown> | null, now: Date): { ok: true; input: DecideInput } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject" && decision !== "cancel") return bad("decision");
  const reference = text(body.reference);
  if (reference && reference.length > 80) return bad("reference");
  const note = text(body.note);
  if (note && note.length > 500) return bad("note");
  let paidOn: string | null = null;
  if (body.paidOn !== undefined && body.paidOn !== null) {
    if (!isDay(body.paidOn) || body.paidOn > istToday(now)) return bad("paidOn");
    paidOn = body.paidOn;
  }
  let confirmAmount: number | null = null;
  if (body.confirmAmount !== undefined && body.confirmAmount !== null) {
    if (typeof body.confirmAmount !== "number" || !Number.isFinite(body.confirmAmount) || body.confirmAmount <= 0) return bad("confirmAmount");
    confirmAmount = Math.round(body.confirmAmount * 100) / 100;
  }
  if (decision === "approve" && !reference) return { ok: false, status: 400, error: "reference_required" };
  if (decision === "reject" && (!note || note.length < 3)) return { ok: false, status: 400, error: "note_required" };
  return { ok: true, input: { clientActionId: body.clientActionId, decision, reference, paidOn, confirmAmount, note } };
}

export function parseDepositDecision(
  body: Record<string, unknown> | null
): { ok: true; input: { clientActionId: string; decision: "confirm" | "dispute"; note: string | null } } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  const decision = body.decision;
  if (decision !== "confirm" && decision !== "dispute") return bad("decision");
  const note = text(body.note);
  if (note && note.length > 500) return bad("note");
  if (decision === "dispute" && (!note || note.length < 3)) return { ok: false, status: 400, error: "note_required" };
  return { ok: true, input: { clientActionId: body.clientActionId, decision, note } };
}

export function parseDisputeResolution(
  body: Record<string, unknown> | null
): { ok: true; input: { clientActionId: string; resolution: string } } | Fail {
  if (!body) return bad("body");
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) return bad("clientActionId");
  const resolution = text(body.resolution);
  if (!resolution || resolution.length < 3 || resolution.length > 500) return bad("resolution");
  return { ok: true, input: { clientActionId: body.clientActionId, resolution } };
}

/** A payment, deposit or dispute RPC's error → the pinned answer. */
export function mapPaymentRpcError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  if (message === "amount_changed") {
    return { ok: false, status: 409, error: "amount_changed", extra: { amount: Number(e.details ?? 0) } };
  }
  if (message === "same_person" || message === "not_requester") {
    return { ok: false, status: 403, error: message };
  }
  if (message === "negative_net") {
    return { ok: false, status: 409, error: "negative_net", extra: { netPayable: Number(e.details ?? 0) } };
  }
  if (["duplicate_pending", "nothing_to_pay", "already_decided", "already_resolved", "not_supported", "manual_handover_exists",
       "not_draft", "rebuilding", "invalid_settlement", "already_void", "paid_batch"].includes(message)) {
    return { ok: false, status: 409, error: message };
  }
  if (message === "reference_required" || message === "note_required") return { ok: false, status: 400, error: message };
  if (message === "reason_required") return { ok: false, status: 400, error: "note_required" };
  if (["invalid_period", "invalid_method", "invalid_amount"].includes(message)) {
    return { ok: false, status: 400, error: "bad_request", extra: { field: message.replace("invalid_", "") } };
  }
  return mapRpcError(e);
}
