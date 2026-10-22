import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listAlerts } from "@/lib/data-access/manager-alerts";
import { parseAlertQuery } from "@/lib/ops/alerts-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/alerts — the alerts of the manager's zones they can act on
 * (§14): status (open, acknowledged, resolved; default open,acknowledged),
 * kind, severity, zone, from / to (opened, IST dates; resolved defaults to the
 * last 7 days), cursor, limit ≤ 100. Critical first, then newest activity.
 * Platform-wide alerts are incidents only for managers; finance, marketing
 * and support kinds need their switch.
 *
 * → 200 { items: [Alert], nextCursor, counts: { open, acknowledged, critical } }
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const q = parseAlertQuery(new URL(request.url).searchParams);
  if ("error" in q) return NextResponse.json(q, { status: 400 });
  try {
    const viewer = { admin: ctx.profile.role === "admin", permissions: ctx.permissions };
    return NextResponse.json(await listAlerts(ctx.scope, viewer, q, new Date()), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
