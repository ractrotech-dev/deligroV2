import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeAllows } from "@/lib/auth/manager-scope";
import type { ManagerApiContext } from "@/lib/auth/manager-api.server";
import { deferNotify } from "@/lib/notifications/defer";
import { stopRiderRing } from "@/lib/notifications/order-events";
import { dispatchOrder } from "@/lib/dispatch/rider-dispatch";
import {
  createStaffLogin,
  deleteStaffLogin,
  EmployeeEmailTakenError,
  EmployeePhoneTakenError,
} from "@/lib/data-access/employees";
import { riderVisible } from "@/lib/data-access/manager-riders";
import { removeRiderDocumentFile, storeRiderDocumentFile } from "@/lib/data-access/rider-profile";
import { maskNumber, toRiderDocument } from "@/lib/ops/rider-rules";
import {
  awaitPriorOnboard,
  loginEmailFor,
  mapRiderRpcError,
  replayAnswer,
  validateRiderDocFields,
  type OnboardRiderInput,
  type ParsedRiderAction,
  type PriorAction,
} from "@/lib/ops/rider-actions";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { RiderDocType, RiderDocument } from "@/lib/ops/rider-contract";

/**
 * Manager rider actions (§5.2, §5.3, §5.13): verification, suspension, force
 * offline, document review and upload, adjustments, onboarding. Each change and
 * its audit row are one 0151 RPC that re-checks the actor against the rider's
 * zones in the database; side effects (stopping a ringing offer, re-dispatching
 * the orders it released) run after the response, and only when the RPC did
 * the work (`replayed` false), so a double tap fires them once.
 *
 * Callers authorise first (managerApiContext + the action's switch).
 */

type Failure = Extract<OpsResult, { ok: false }>;
const NOT_FOUND: Failure = { ok: false, status: 404, error: "not_found" };

interface RpcError { code?: string; message?: string; details?: string | null }

async function rpc(name: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> | null; error: RpcError | null }> {
  const { data, error } = await createAdminClient().rpc(name, args);
  return { data: (data ?? null) as Record<string, unknown> | null, error: error as RpcError | null };
}

/**
 * The offers the RPC released, read inside it under the locks it took on the
 * rider's deliveries — an offer made between a separate read and the RPC would
 * otherwise keep ringing a rider who can no longer take it.
 */
function releasedOffers(state: Record<string, unknown> | null): { orderId: string; stage: "accepted" | "ready" }[] {
  const list = Array.isArray(state?.released_offers) ? (state.released_offers as { order_id?: unknown; order_status?: unknown }[]) : [];
  return list
    .filter((o): o is { order_id: string; order_status?: unknown } => typeof o?.order_id === "string")
    .map((o) => ({ orderId: o.order_id, stage: o.order_status === "ready" ? "ready" : "accepted" }));
}

export async function actOnRider(ctx: ManagerApiContext, riderId: string, a: ParsedRiderAction): Promise<OpsResult> {
  if (!(await riderVisible(ctx.scope, riderId))) return NOT_FOUND;
  const actor = ctx.profile.id;
  const takesOffline = a.action === "suspend" || a.action === "reject" || a.action === "force_offline";

  let res: { data: Record<string, unknown> | null; error: RpcError | null };
  switch (a.action) {
    case "approve":
    case "reject":
      res = await rpc("ops_set_rider_verification", {
        p_actor: actor, p_rider: riderId, p_decision: a.action, p_expected: a.expected, p_reason: a.reason,
        p_override: a.action === "approve" ? a.override : false, p_client_action_id: a.clientActionId,
      });
      break;
    case "suspend":
    case "reactivate":
      res = await rpc("ops_set_rider_account", {
        p_actor: actor, p_rider: riderId, p_decision: a.action, p_expected: a.expected, p_reason: a.reason,
        p_client_action_id: a.clientActionId,
      });
      break;
    case "force_offline":
      res = await rpc("ops_force_rider_offline", { p_actor: actor, p_rider: riderId, p_reason: a.reason, p_client_action_id: a.clientActionId });
      break;
    case "verify_document":
    case "reject_document": {
      // The document must be THIS rider's: the URL names the rider, the RPC
      // checks the zone through the document's own rider.
      const { data: doc, error } = await createAdminClient()
        .from("rider_documents")
        .select("id")
        .eq("id", a.documentId)
        .eq("driver_id", riderId)
        .maybeSingle();
      if (error) throw error;
      if (!doc) return NOT_FOUND;
      res = await rpc("ops_review_rider_document", {
        p_actor: actor, p_document: a.documentId, p_decision: a.action === "verify_document" ? "verify" : "reject",
        p_remarks: a.remarks, p_client_action_id: a.clientActionId,
      });
      break;
    }
    case "add_adjustment":
      res = await rpc("ops_add_rider_adjustment", {
        p_actor: actor, p_rider: riderId, p_kind: a.kind, p_amount: a.amount, p_reason: a.reason,
        p_effective_on: a.effectiveOn, p_order: a.orderId, p_client_action_id: a.clientActionId,
      });
      break;
  }
  if (res.error) {
    if (res.error.message === "reason_required" && a.action === "reject_document") {
      return { ok: false, status: 400, error: "remarks_required" };
    }
    return mapRiderRpcError(res.error);
  }

  const offers = takesOffline && res.data?.replayed !== true ? releasedOffers(res.data) : [];
  if (offers.length > 0) {
    deferNotify(async () => {
      for (const o of offers) {
        await stopRiderRing(riderId, o.orderId);
        await dispatchOrder(o.orderId, o.stage, { excludeRiderIds: [riderId] });
      }
    });
  }
  return { ok: true };
}

// ── onboarding ───────────────────────────────────────────────────────────────

export type OnboardResult =
  | { ok: true; riderId: string; riderCode: string; credentials: { mobile: string; password: string } | null }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string };

/**
 * §5.2. The login is created first (auth cannot share a transaction with SQL),
 * then the rider — role, zone, profile, pending verification — and the audit
 * row in one RPC; if the RPC fails the login is removed again. A replayed
 * clientActionId answers with the rider it already created and no credentials
 * (they were shown once).
 */
export async function onboardRider(ctx: ManagerApiContext, input: OnboardRiderInput): Promise<OnboardResult> {
  if (!scopeAllows(ctx.scope, input.zoneId)) return { ok: false, status: 404, error: "not_found" };
  const supabase = createAdminClient();

  const lookupPrior = async (): Promise<PriorAction | null> => {
    const { data } = await supabase
      .from("ops_audit_log")
      .select("actor_id, action, entity_id")
      .eq("client_action_id", input.clientActionId)
      .maybeSingle<PriorAction>();
    return data ?? null;
  };
  const answerReplay = async (prior: PriorAction | null): Promise<OnboardResult | null> => {
    const r = replayAnswer(prior, ctx.profile.id);
    if (!r) return null;
    // Someone else's id, or this manager's id spent on another action: 409
    // stale, as every ops route answers client_action_id_conflict.
    if (r.kind === "stale" || r.kind === "conflict") return { ok: false, status: 409, error: "stale" };
    const { data: code } = await supabase.from("rider_profiles").select("rider_code").eq("driver_id", r.riderId).maybeSingle<{ rider_code: string }>();
    return { ok: true, riderId: r.riderId, riderCode: code?.rider_code ?? "", credentials: null };
  };
  const replay = await answerReplay(await lookupPrior());
  if (replay) return replay;

  let login: { userId: string; password: string };
  try {
    login = await createStaffLogin({
      email: loginEmailFor(input),
      fullName: input.fullName,
      phone: input.mobile,
      password: input.password,
    });
  } catch (e) {
    if (e instanceof EmployeeEmailTakenError || e instanceof EmployeePhoneTakenError) {
      // A second send of this same onboarding, racing the first: its login
      // exists because the first call made it. Wait for the first call's
      // result and answer with that rather than "taken".
      const won = await answerReplay(await awaitPriorOnboard(lookupPrior));
      if (won) return won;
      return { ok: false, status: 409, error: e instanceof EmployeeEmailTakenError ? "email_taken" : "phone_taken" };
    }
    throw e;
  }

  const { data, error } = await rpc("ops_onboard_rider", {
    p_actor: ctx.profile.id,
    p_user: login.userId,
    p_zone: input.zoneId,
    p_profile: {
      fullName: input.fullName,
      phone: input.mobile,
      vehicleType: input.vehicleType,
      vehicleOwner: input.vehicleOwner,
      vehicleRegistration: input.vehicleRegistration,
      licenceNumber: input.licenceNumber,
      licenceExpiresOn: input.licenceExpiresOn,
      addressLine: input.addressLine,
      pincode: input.pincode,
      emergencyName: input.emergencyName,
      emergencyPhone: input.emergencyPhone,
      emergencyRelation: input.emergencyRelation,
    },
    p_client_action_id: input.clientActionId,
  });
  if (error) {
    await deleteStaffLogin(login.userId);
    if (error.code === "23505" && !(error.message ?? "").includes("client_action_id")) return { ok: false, status: 409, error: "phone_taken" };
    const mapped = mapRiderRpcError(error);
    if (mapped.ok) return { ok: false, status: 500, error: "action_failed" };
    return { ok: false, status: mapped.status, error: mapped.error };
  }
  return {
    ok: true,
    riderId: login.userId,
    riderCode: String(data?.rider_code ?? ""),
    credentials: input.password ? null : { mobile: input.mobile, password: login.password },
  };
}

// ── document upload ──────────────────────────────────────────────────────────

export type UploadResult =
  | { ok: true; document: RiderDocument }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string };

/** A manager uploads a rider's document (§5.2): checked file, stored, recorded with its audit row. */
export async function uploadRiderDocumentAsOps(
  ctx: ManagerApiContext,
  riderId: string,
  input: { type: string; number: string | null; expiresOn: string | null; file: File; clientActionId: string }
): Promise<UploadResult> {
  if (!(await riderVisible(ctx.scope, riderId))) return { ok: false, status: 404, error: "not_found" };
  const fields = validateRiderDocFields(input.type, input.number, input.expiresOn);
  if (!fields.ok) return { ok: false, status: 400, error: fields.error };
  const stored = await storeRiderDocumentFile(riderId, fields.type, input.file);
  if (!stored.ok) return { ok: false, status: 400, error: stored.error };

  const { data, error } = await rpc("ops_add_rider_document", {
    p_actor: ctx.profile.id,
    p_rider: riderId,
    p_type: fields.type,
    p_number: fields.number,
    p_number_masked: maskNumber(fields.number),
    p_expires_on: fields.expiresOn,
    p_file_path: stored.path,
    p_client_action_id: input.clientActionId,
  });
  if (error || data?.replayed === true) await removeRiderDocumentFile(stored.path);
  if (error) {
    const mapped = mapRiderRpcError(error);
    return mapped.ok ? { ok: false, status: 500, error: "action_failed" } : { ok: false, status: mapped.status, error: mapped.error };
  }
  const docId = String(data?.document_id ?? "");
  const { data: row, error: readErr } = await createAdminClient()
    .from("rider_documents")
    .select("id, doc_type, number, expires_on, status, remarks, reviewed_at, created_at")
    .eq("id", docId)
    .maybeSingle<{ id: string; doc_type: RiderDocType; number: string | null; expires_on: string | null; status: RiderDocument["status"]; remarks: string | null; reviewed_at: string | null; created_at: string }>();
  if (readErr || !row) return { ok: false, status: 500, error: "action_failed" };
  return {
    ok: true,
    document: toRiderDocument({
      id: row.id, type: row.doc_type, number: row.number, expiresOn: row.expires_on, status: row.status,
      remarks: row.remarks, reviewedBy: null, reviewedAt: row.reviewed_at, uploadedAt: row.created_at,
    }),
  };
}
