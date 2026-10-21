import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeAllows, type ManagerScope } from "@/lib/auth/manager-scope";
import { deferNotify } from "@/lib/notifications/defer";
import { documentDecisionText, notifyVendorOps, vendorStatusText } from "@/lib/notifications/vendor-ops";
import {
  createVendorAccount,
  EmailTakenError,
  PhoneTakenError,
} from "@/lib/data-access/vendor-registration";
import {
  removeVendorDocumentFile,
  storeVendorDocumentFile,
  type VendorDocType,
} from "@/lib/data-access/vendor-documents";
import { listVendorDocumentItems, scopedVendorRow } from "@/lib/data-access/manager-vendors";
import { mapVendorRpcError, type OnboardInput } from "@/lib/ops/vendor-actions";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { VendorDocumentItem } from "@/lib/ops/vendor-contract";
import type { VendorAction, VendorStatus } from "@/lib/ops/vendor-rules";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export { mapVendorRpcError } from "@/lib/ops/vendor-actions";

/**
 * Manager vendor actions (§4.2, §4.4, §4.5): status decisions, document review,
 * onboarding and document uploads. Each change and its audit row are one
 * 0145 RPC that re-checks the actor's zone in the database; pushes to the shop
 * go after the response (deferNotify). Callers authorise first
 * (managerApiContext + the action's switch).
 */

/** An action that did not happen, and why. */
type OpsFailure = Extract<OpsResult, { ok: false }>;

const NOT_FOUND: OpsFailure = { ok: false, status: 404, error: "not_found" };

interface RpcError { code?: string; message?: string; details?: string | null }

async function rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
  const { data, error } = await createAdminClient().rpc(name, args);
  return { data, error: error as RpcError | null };
}

/** Has this actor already done this client action? (Their own id → a replay; push nothing twice.) */
async function alreadyDone(actorId: string, clientActionId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("ops_audit_log")
    .select("actor_id")
    .eq("client_action_id", clientActionId)
    .maybeSingle();
  return !!data && (data as { actor_id: string }).actor_id === actorId;
}

export async function opsVendorStatus(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  action: VendorAction,
  expected: VendorStatus,
  reason: string,
  override: boolean,
  clientActionId: string
): Promise<OpsResult> {
  if (!(await scopedVendorRow(scope, id))) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await rpc("ops_set_vendor_status", {
    p_actor: actor.id,
    p_restaurant: id,
    p_action: action,
    p_expected: expected,
    p_reason: reason,
    p_override: override,
    p_client_action_id: clientActionId,
  });
  if (error) return mapVendorRpcError(error);
  if (!replay) {
    deferNotify(() => notifyVendorOps(id, "status", vendorStatusText(action, reason), "/more/shop"));
  }
  return { ok: true };
}

export async function opsReviewDocument(
  actor: OpsActor,
  scope: ManagerScope,
  vendorId: string,
  documentId: string,
  decision: "verified" | "rejected",
  remarks: string | null,
  clientActionId: string
): Promise<OpsResult> {
  if (!(await scopedVendorRow(scope, vendorId))) return NOT_FOUND;
  const { data: doc } = await createAdminClient()
    .from("vendor_documents")
    .select("id, doc_type")
    .eq("id", documentId)
    .eq("restaurant_id", vendorId)
    .maybeSingle<{ id: string; doc_type: string }>();
  if (!doc) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await rpc("ops_review_vendor_document", {
    p_actor: actor.id,
    p_document: documentId,
    p_decision: decision,
    p_remarks: remarks,
    p_client_action_id: clientActionId,
  });
  if (error) return mapVendorRpcError(error);
  if (!replay) {
    deferNotify(() => notifyVendorOps(vendorId, "document", documentDecisionText(doc.doc_type, decision, remarks), "/more/shop/documents"));
  }
  return { ok: true };
}

/**
 * §4.2. The owner's login is created first (auth cannot share a transaction
 * with SQL), then the shop, its menu and the audit row in one RPC; if the RPC
 * fails the login is removed again (createVendorAccount's compensation).
 */
export async function opsOnboardVendor(
  actor: OpsActor,
  scope: ManagerScope,
  input: OnboardInput
): Promise<{ ok: true; id: string; slug: string; credentials?: { email: string; password: string } } | OpsFailure> {
  if (!scopeAllows(scope, input.zoneId)) return NOT_FOUND;
  // A replay answers with the shop the first call made, and creates no second login.
  const { data: prior } = await createAdminClient()
    .from("ops_audit_log")
    .select("actor_id, after")
    .eq("client_action_id", input.clientActionId)
    .maybeSingle<{ actor_id: string; after: { restaurantId?: string; slug?: string } | null }>();
  if (prior) {
    if (prior.actor_id !== actor.id || !prior.after?.restaurantId) return { ok: false, status: 409, error: "stale" };
    return { ok: true, id: prior.after.restaurantId, slug: prior.after.slug ?? "" };
  }

  try {
    const created = await createVendorAccount(
      {
        shopName: input.shopName,
        ownerName: input.ownerName,
        mobile: input.mobile,
        email: input.email,
        password: input.password ?? undefined,
        category: input.category ?? undefined,
        description: input.description ?? undefined,
        address: input.address,
        landmark: input.landmark ?? undefined,
        pincode: input.pincode ?? undefined,
        lat: input.lat,
        lng: input.lng,
        openingTime: input.openingTime ?? undefined,
        closingTime: input.closingTime ?? undefined,
        weeklyOff: input.weeklyOff,
        deliveryAvailable: input.deliveryAvailable,
        selfPickup: input.selfPickup,
        fssaiNumber: input.fssaiNumber ?? undefined,
      },
      actor.id,
      { zoneId: input.zoneId, clientActionId: input.clientActionId }
    );
    return {
      ok: true,
      id: created.restaurantId,
      slug: created.slug,
      ...(input.password ? {} : { credentials: { email: input.email, password: created.password } }),
    };
  } catch (err) {
    if (err instanceof EmailTakenError) return { ok: false, status: 409, error: "email_taken" };
    if (err instanceof PhoneTakenError) return { ok: false, status: 409, error: "phone_taken" };
    const e = err as RpcError;
    if (e && (e.message === "forbidden" || e.code === "42501")) return NOT_FOUND;
    throw err;
  }
}

/** §4.5: upload a document for the shop, recorded and audited in one RPC. */
export async function opsUploadDocument(
  actor: OpsActor,
  scope: ManagerScope,
  vendorId: string,
  type: VendorDocType,
  file: File,
  clientActionId: string
): Promise<{ ok: true; document: VendorDocumentItem } | OpsFailure> {
  if (!(await scopedVendorRow(scope, vendorId))) return NOT_FOUND;
  if (await alreadyDone(actor.id, clientActionId)) {
    const { data } = await createAdminClient()
      .from("ops_audit_log")
      .select("after")
      .eq("client_action_id", clientActionId)
      .maybeSingle<{ after: { documentId?: string } | null }>();
    const doc = (await listVendorDocumentItems(vendorId)).find((d) => d.id === data?.after?.documentId);
    return doc ? { ok: true, document: doc } : NOT_FOUND;
  }

  let path: string;
  try {
    path = await storeVendorDocumentFile(vendorId, type, file);
  } catch (err) {
    const message = (err as Error).message;
    if (message === "invalid_type" || message === "too_large") {
      return { ok: false, status: 400, error: "bad_file" };
    }
    throw err;
  }
  const { data, error } = await rpc("ops_add_vendor_document", {
    p_actor: actor.id,
    p_restaurant: vendorId,
    p_type: type,
    p_storage_path: path,
    p_file_name: file.name || `${type}-${randomUUID().slice(0, 6)}`,
    p_client_action_id: clientActionId,
  });
  if (error) {
    await removeVendorDocumentFile(path);
    return mapVendorRpcError(error) as OpsFailure;
  }
  const documentId = (data as { document_id: string }).document_id;
  const doc = (await listVendorDocumentItems(vendorId)).find((d) => d.id === documentId);
  return doc ? { ok: true, document: doc } : NOT_FOUND;
}
