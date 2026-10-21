import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listVendorComplaints } from "@/lib/data-access/manager-vendors";

export const dynamic = "force-dynamic";

const STATUSES = ["open", "in_progress", "waiting_on_requester", "escalated", "resolved", "closed"];

/**
 * GET /api/manager/vendors/[id]/complaints?status=&cursor= — tickets linked to
 * the shop (by their order, or raised by the shop), newest first (§4.15).
 * `status` is a comma list; empty means every status.
 *
 * → 200 { items: TicketSummary[], nextCursor }   → 400 { error: "bad_request", field }
 * → 404 { error: "not_found" }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.vendors.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const sp = new URL(request.url).searchParams;
  const statuses = (sp.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.some((s) => !STATUSES.includes(s))) {
    return NextResponse.json({ error: "bad_request", field: "status" }, { status: 400 });
  }

  try {
    const page = await listVendorComplaints(ctx.scope, id.toLowerCase(), statuses, sp.get("cursor"));
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(page);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
