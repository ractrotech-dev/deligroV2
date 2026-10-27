import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { readFormLimited } from "@/lib/http/limited-body";
import { getManagerProductDetail } from "@/lib/data-access/manager-products";
import { opsReplacePhoto } from "@/lib/data-access/manager-product-actions";
import { MAX_MENU_PHOTO_BYTES } from "@/lib/data-access/menu-photo";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parsePhotoReplaceBody } from "@/lib/ops/product-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/products/[id]/photo — replace a dish's photo.
 *   multipart: `file` (jpeg/png/webp ≤ 2 MB, the bytes checked against the
 *              claimed type), `clientActionId`, optional `reviewChangeId`
 *   JSON:      { libraryImageId, clientActionId, reviewChangeId? } — a Deligro
 *              library photo
 * Counts as reviewed and resolves an open "wrong photo" flag (0176).
 * Needs manager.products.replace_photo. 30 a minute.
 *
 * → 200 { ok: true, product }   → 400 bad_file | bad_request
 * → 403 permission_denied   → 404 not_found   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.permissions["manager.products.replace_photo"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.products.replace_photo" }, { status: 403 });
  }

  const limited = await managerWriteLimit(ctx, "photo-replace", 30);
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const id = rawId.toLowerCase();

  let fields: Record<string, unknown> | null;
  let file: File | null = null;
  if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    // The limit holds while the body streams in (a chunked upload has no Content-Length).
    const form = await readFormLimited(request, MAX_MENU_PHOTO_BYTES + 64 * 1024);
    if (form === "too_large") return NextResponse.json({ error: "bad_file" }, { status: 400 });
    if (form === "bad") return NextResponse.json({ error: "bad_request", field: "body" }, { status: 400 });
    const f = form.get("file");
    if (!(f instanceof File)) return NextResponse.json({ error: "bad_request", field: "file" }, { status: 400 });
    file = f;
    fields = {};
    for (const [k, v] of form.entries()) if (typeof v === "string" && k !== "libraryImageId") fields[k] = v;
  } else {
    fields = await readJsonObject(request);
    if (fields && !fields.libraryImageId) return NextResponse.json({ error: "bad_request", field: "libraryImageId" }, { status: 400 });
  }
  const parsed = parsePhotoReplaceBody(fields);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsReplacePhoto(actor, ctx.scope, id, parsed.value, file);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  try {
    const product = await getManagerProductDetail(ctx.scope, id, { permissions: ctx.permissions, now: new Date() });
    return NextResponse.json({ ok: true, product });
  } catch {
    // The photo is replaced; only the re-read failed.
    return NextResponse.json({ ok: true, product: null });
  }
}
