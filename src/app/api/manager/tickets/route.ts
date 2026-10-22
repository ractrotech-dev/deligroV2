import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listTickets } from "@/lib/data-access/manager-tickets";
import { parseTicketQuery } from "@/lib/ops/support-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/tickets — the support queue across vendor, rider and
 * customer tickets in the manager's zones (§11.1–11.2). Filters: status (a
 * comma list, or `active`), category, priority, requesterRole, from / to
 * (IST dates, created), zone, assignee (`me` | `unassigned` | id), team,
 * vendor, rider, q (ticket number, or 3+ characters of the subject), cursor,
 * limit (≤ 100). Escalated and emergency tickets lead the first page.
 *
 * → 200 { items: [TicketListItem], nextCursor, counts }   (counts on the first page only, else null)
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const q = parseTicketQuery(new URL(request.url).searchParams);
  if ("error" in q) return NextResponse.json(q, { status: 400 });

  const viewer: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const page = await listTickets(ctx.scope, viewer, q, new Date());
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
