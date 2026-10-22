import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listAudit } from "@/lib/data-access/manager-audit";
import { parseAuditQuery } from "@/lib/ops/alerts-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/audit — the zones' audit log (§16), newest first. Needs
 * `manager.audit.view_zone` (default off; a manager's own activity stays on
 * Profile → Activity without it). Filters: actor, action (exact, or a prefix
 * ending `.*`), entityType, entityId, zone, from / to, cursor, limit ≤ 100.
 *
 * → 200 { items: [AuditEntry], nextCursor }   → 400 bad_request   → 403 permission_denied   → 500 load_failed
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.audit.view_zone");
  if (ctx instanceof Response) return ctx;
  const q = parseAuditQuery(new URL(request.url).searchParams);
  if ("error" in q) return NextResponse.json(q, { status: 400 });
  try {
    return NextResponse.json(await listAudit(ctx.scope, q), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
