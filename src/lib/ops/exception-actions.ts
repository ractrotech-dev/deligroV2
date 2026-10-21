/**
 * The exception-decision route's body and error mapping (Phase 5 plan, API
 * contract). Pure.
 */
import { isUuid } from "@/lib/auth/manager-scope";
import { mapRpcError, type OpsResult } from "./order-actions";

export type ExceptionDecision = "approve" | "reject" | "acknowledge";

type Fail = { ok: false; status: 400; error: "bad_request" | "note_required"; field?: string };

export function parseExceptionDecision(
  body: Record<string, unknown> | null
): { ok: true; input: { clientActionId: string; decision: ExceptionDecision; note: string | null } } | Fail {
  if (!body) return { ok: false, status: 400, error: "bad_request", field: "body" };
  if (typeof body.clientActionId !== "string" || !isUuid(body.clientActionId)) {
    return { ok: false, status: 400, error: "bad_request", field: "clientActionId" };
  }
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject" && decision !== "acknowledge") {
    return { ok: false, status: 400, error: "bad_request", field: "decision" };
  }
  const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : null;
  if (note && note.length > 500) return { ok: false, status: 400, error: "bad_request", field: "note" };
  if (decision === "reject" && (!note || note.length < 3)) return { ok: false, status: 400, error: "note_required" };
  return { ok: true, input: { clientActionId: body.clientActionId, decision, note } };
}

/** The decision RPC's error → the pinned answer. */
export function mapExceptionError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  if (message === "already_resolved") return { ok: false, status: 409, error: "already_resolved" };
  if (message === "note_required") return { ok: false, status: 400, error: "note_required" };
  return mapRpcError(e);
}
