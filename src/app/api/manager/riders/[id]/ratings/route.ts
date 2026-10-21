import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getRiderRatingsPage } from "@/lib/data-access/manager-riders";
import { decodeTimeCursor } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders/[id]/ratings — the rider's ratings (§5.12), newest
 * first, 50 a page; never who left them.
 *
 * → 200 { items: { rating, comment, at, orderCode }[], nextCursor }
 * → 400 { error: "bad_request", field: "cursor" }   → 404 not_found   → 500 load_failed
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const raw = new URL(request.url).searchParams.get("cursor");
  const cursor = raw ? decodeTimeCursor(raw) : null;
  if (raw && (!cursor || !isUuid(cursor.id))) return NextResponse.json({ error: "bad_request", field: "cursor" }, { status: 400 });

  try {
    const page = await getRiderRatingsPage(ctx.scope, id.toLowerCase(), cursor);
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(page);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
