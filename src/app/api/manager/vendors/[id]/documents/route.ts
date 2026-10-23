import { readFormLimited } from "@/lib/http/limited-body";
import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsUploadDocument } from "@/lib/data-access/manager-vendor-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import type { VendorDocType } from "@/lib/data-access/vendor-documents";
import { checkUpload, UPLOAD_MAX_BYTES } from "@/lib/ops/vendor-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/vendors/[id]/documents — multipart upload of one shop
 * document (§4.2, §4.5): fields `type`, `file` (jpeg/png/webp/pdf ≤ 10 MB, the
 * bytes checked against the claimed type), `clientActionId`. The file goes to
 * the private vendor-docs bucket; the row and its audit entry are one RPC.
 *
 * → 201 { document }   → 400 { error: "bad_file" | "bad_request", field? }
 * → 403 permission_denied (manager.vendors.onboard)   → 404 not_found   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.vendors.onboard");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "vendor-documents", 20);
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The limit holds while the body streams in (a chunked upload has no Content-Length).
  const read = await readFormLimited(request, UPLOAD_MAX_BYTES + 64 * 1024);
  if (read === "too_large") return NextResponse.json({ error: "bad_file" }, { status: 400 });
  if (read === "bad") return NextResponse.json({ error: "bad_request", field: "body" }, { status: 400 });
  const form = read;
  const type = String(form.get("type") ?? "");
  const file = form.get("file");
  const clientActionId = String(form.get("clientActionId") ?? "");
  if (!isUuid(clientActionId)) return NextResponse.json({ error: "bad_request", field: "clientActionId" }, { status: 400 });
  if (!(file instanceof File) || checkUpload(type, file.type, file.size)) {
    return NextResponse.json({ error: "bad_file" }, { status: 400 });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsUploadDocument(actor, ctx.scope, rawId.toLowerCase(), type as VendorDocType, file, clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ document: result.document }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
