import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getRiderHistoryForManager } from "@/lib/data-access/manager-riders";
import { parseHistoryQuery } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders/[id]/history — the rider's finished jobs (§5.10,
 * §5.11): delivered, failed, cancelled and reassigned away, newest first, 50 a
 * page. Query: from, to (IST dates), outcome, cursor.
 *
 * → 200 { items: RiderHistoryItem[], nextCursor, totals }
 * → 400 { error: "bad_request", field }   → 404 not_found   → 500 load_failed
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseHistoryQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    const page = await getRiderHistoryForManager(ctx.scope, id.toLowerCase(), parsed.query);
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(page);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
