import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getRiderForManager, viewerOf } from "@/lib/data-access/manager-riders";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders/[id] — one rider (§5.2–§5.15): account and
 * verification, profile (licence masked), live position only while online or
 * on a delivery, active jobs with ETA and route, the last 30 days'
 * performance with months, ratings (never who left them), documents (numbers
 * masked), cash, open exceptions and complaints, the actions this manager may
 * take — and, with manager.finance.view only, the money block.
 *
 * → 200 { rider: RiderDetail }   → 404 { error: "not_found" } (missing and out
 *   of zone look the same)   → 500 { error: "load_failed" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const rider = await getRiderForManager(ctx.scope, id.toLowerCase(), viewerOf(ctx), new Date());
    if (!rider) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ rider });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
