import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listActivity } from "@/lib/data-access/ops-audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/activity?page=1&pageSize=50 — the signed-in person's own
 * entries in the ops audit log, newest first (§15.8).
 *
 * → { items: [{ id, action, entityType, entityId, zoneId, reason, createdAt }], page, hasMore }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "50");

  try {
    return NextResponse.json(await listActivity(ctx.profile.id, { page, pageSize }));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
