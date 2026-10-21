import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getManagerVendorDetail } from "@/lib/data-access/manager-vendors";
import { opsReviewDocument, opsVendorStatus } from "@/lib/data-access/manager-vendor-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { VENDOR_ACTION_PERMISSION, parseVendorActionBody } from "@/lib/ops/vendor-actions";
import type { OpsResult } from "@/lib/ops/order-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/vendors/[id]/actions — approve, reject, suspend or
 * reactivate a shop, or verify / reject one of its documents (§4.4, §4.5).
 * Body and answers: the Phase 4 plan's API contract.
 *
 * Status actions need the shop's current status as `expected` (two managers
 * deciding at once: the second gets 409 stale) and a 3–300 character reason.
 * The change and its audit row are one RPC (0145) that re-checks the zone in
 * the database; a replayed clientActionId answers 200 and changes nothing.
 * 60 writes a minute per manager.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.vendors.view");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "vendor-actions");
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const id = rawId.toLowerCase();

  const parsed = parseVendorActionBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }
  const a = parsed.action;
  const permission = VENDOR_ACTION_PERMISSION[a.action];
  if (ctx.permissions[permission] !== true) {
    return NextResponse.json({ error: "permission_denied", permission }, { status: 403 });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  let result: OpsResult;
  try {
    if (a.action === "verify_document" || a.action === "reject_document") {
      result = await opsReviewDocument(
        actor, ctx.scope, id, a.documentId, a.action === "verify_document" ? "verified" : "rejected", a.reason, a.clientActionId
      );
    } else {
      result = await opsVendorStatus(actor, ctx.scope, id, a.action, a.expected, a.reason, a.override, a.clientActionId);
    }
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });

  try {
    const vendor = await getManagerVendorDetail(ctx.scope, id, { permissions: ctx.permissions, now: new Date() });
    return NextResponse.json({ ok: true, vendor });
  } catch {
    // The action is done; only the re-read failed. Say so rather than 500 the change.
    return NextResponse.json({ ok: true, vendor: null });
  }
}
