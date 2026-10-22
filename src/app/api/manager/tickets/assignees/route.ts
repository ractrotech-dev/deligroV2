import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listAssignees } from "@/lib/data-access/manager-tickets";
import { TEAMS } from "@/lib/ops/support-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/tickets/assignees?zone= — who a ticket may be assigned to:
 * every admin, and the managers of the manager's zones (or the one zone) whose
 * support switch is on, each with how many open tickets they hold (§11.3).
 *
 * → 200 { staff: [{ id, name, role, openAssigned }], teams }   → 400 bad_request   → 500 load_failed
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const zone = new URL(request.url).searchParams.get("zone");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });

  try {
    const staff = await listAssignees(ctx.scope, zone ? zone.toLowerCase() : null);
    return NextResponse.json({ staff, teams: TEAMS }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
