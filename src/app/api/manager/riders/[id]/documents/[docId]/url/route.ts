import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { riderDocumentUrlForManager } from "@/lib/data-access/manager-riders";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders/[id]/documents/[docId]/url — a 60-second signed link
 * to one of the rider's documents in the private rider-documents bucket,
 * issued only after the rider is found in the manager's zones (§5.2).
 *
 * → 200 { url, expiresAt }   → 404 not_found   → 500 load_failed
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const { id, docId } = await params;
  if (!isUuid(id) || !isUuid(docId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const link = await riderDocumentUrlForManager(ctx.scope, id.toLowerCase(), docId.toLowerCase());
    if (!link) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(link);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
