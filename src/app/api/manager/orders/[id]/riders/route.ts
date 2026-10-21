import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listRiderCandidates } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/orders/[id]/riders — who could take this order (§3.14,
 * §5.9, §6.9): eligible riders first, nearest and least loaded first, then the
 * rest with the reason each cannot (offline, on a break, no recent fix,
 * suspended, another zone, already on it).
 *
 * Needs manager.assign_rider or manager.reassign_rider.
 * → 200 { riders: RiderCandidate[] }   → 404 { error: "not_found" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  if (!ctx.permissions["manager.assign_rider"] && !ctx.permissions["manager.reassign_rider"]) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.assign_rider" }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const riders = await listRiderCandidates(ctx.scope, id.toLowerCase(), new Date());
    if (!riders) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ riders });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
