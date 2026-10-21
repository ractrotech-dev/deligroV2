import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listCashDisputes } from "@/lib/data-access/manager-cash";
import { decodeTimeCursor } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/cash/disputes — cash disputes riders in the manager's zones
 * raised ("my count is different", §5.14). Query: status (open | resolved),
 * cursor. Needs manager.cash.
 *
 * → 200 { items: CashDispute[], nextCursor, counts: { open, resolved } }   → 400 bad_request
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.cash");
  if (ctx instanceof Response) return ctx;
  const p = new URL(request.url).searchParams;
  const status = p.get("status");
  if (status && status !== "open" && status !== "resolved") return NextResponse.json({ error: "bad_request", field: "status" }, { status: 400 });
  const raw = p.get("cursor");
  const cursor = raw ? decodeTimeCursor(raw) : null;
  if (raw && (!cursor || !isUuid(cursor.id))) return NextResponse.json({ error: "bad_request", field: "cursor" }, { status: 400 });
  try {
    return NextResponse.json(await listCashDisputes(ctx.scope, { status: (status as "open" | "resolved") || null, cursor }));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
