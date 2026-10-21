import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getTicketThread } from "@/lib/data-access/manager-tickets";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/tickets/[id] — one ticket in the manager's zones with its
 * whole thread, internal notes included, attachments as 60-second signed URLs
 * (§4.15; Phase 8 extends). A ticket with no zone is admin-only.
 *
 * → 200 { ticket, messages }   → 404 { error: "not_found" }   → 500 { error: "load_failed" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const thread = await getTicketThread(ctx.scope, id.toLowerCase());
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(thread, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
