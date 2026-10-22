import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getAlert } from "@/lib/data-access/manager-alerts";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/alerts/[id] — one alert and its history (opened,
 * escalated_severity, acknowledged, resolved, cleared, reopened).
 *
 * → 200 { alert: Alert, history: [{ at, event, actor, note }] }   → 404 not_found   → 500 load_failed
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const viewer = { admin: ctx.profile.role === "admin", permissions: ctx.permissions };
    const found = await getAlert(ctx.scope, viewer, id.toLowerCase());
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(found, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
