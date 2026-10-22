import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { unreadSummary } from "@/lib/data-access/manager-inbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/notifications/unread-count — the bell's badge: unread inbox
 * rows, and the open and critical alerts the person can see.
 *
 * → 200 { unread, openAlerts, criticalAlerts }   → 500 load_failed
 */
export async function GET() {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  try {
    const viewer = { admin: ctx.profile.role === "admin", permissions: ctx.permissions };
    return NextResponse.json(await unreadSummary(ctx.profile.id, ctx.scope, viewer, new Date()), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
