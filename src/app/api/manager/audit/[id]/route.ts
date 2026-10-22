import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { getAuditEntry } from "@/lib/data-access/manager-audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/audit/[id] — one entry and its before/after difference as
 * flat dotted paths. Needs `manager.audit.view_zone`.
 *
 * → 200 { entry: AuditEntry, diff: [{ path, before, after }] }   → 403 permission_denied   → 404 not_found
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.audit.view_zone");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const found = await getAuditEntry(ctx.scope, Number(id));
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(found, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
