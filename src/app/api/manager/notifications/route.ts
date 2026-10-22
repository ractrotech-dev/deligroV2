import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listInbox } from "@/lib/data-access/manager-inbox";
import { decodeCursor } from "@/lib/ops/alerts-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/notifications?cursor&unread=1 — the signed-in person's own
 * inbox, newest first, 50 a page.
 *
 * → 200 { items: [InboxItem], nextCursor, unread }   → 400 bad_request   → 500 load_failed
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const sp = new URL(request.url).searchParams;
  const raw = sp.get("cursor");
  const cursor = raw ? decodeCursor(raw) : null;
  if (raw && !cursor) return NextResponse.json({ error: "bad_request", field: "cursor" }, { status: 400 });
  try {
    const page = await listInbox(ctx.profile.id, { cursor, unreadOnly: sp.get("unread") === "1", limit: 50 });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
