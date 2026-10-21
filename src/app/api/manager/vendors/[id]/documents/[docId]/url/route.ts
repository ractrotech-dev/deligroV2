import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { vendorDocumentUrl } from "@/lib/data-access/manager-vendors";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/vendors/[id]/documents/[docId]/url — a 60-second signed URL
 * for one of the shop's documents (§4.5). The file stays in the private
 * vendor-docs bucket; only this scope check mints a link to it.
 *
 * → 200 { url, expiresAt }   → 404 { error: "not_found" }   → 500 { error: "load_failed" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const ctx = await managerApiContext("manager.vendors.view");
  if (ctx instanceof Response) return ctx;

  const { id, docId } = await params;
  if (!isUuid(id) || !isUuid(docId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const signed = await vendorDocumentUrl(ctx.scope, id.toLowerCase(), docId.toLowerCase());
    if (!signed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(signed, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
