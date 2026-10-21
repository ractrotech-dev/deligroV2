import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listExceptions } from "@/lib/data-access/delivery-exceptions";
import { decodeTimeCursor } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "rejected", "acknowledged"] as const;

/**
 * GET /api/manager/exceptions — delivery exceptions riders in the manager's
 * zones raised: requests (customer unreachable, wrong address, complete without
 * the code, failed delivery, manual pickup, go offline) and reports. Query:
 * status (pending = the queue, oldest first), rider, cursor. Each item lists
 * the decisions THIS viewer can take (none without manager.exceptions.decide).
 *
 * → 200 { items: DeliveryException[], nextCursor, counts: { pending } }   → 400 bad_request
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;
  const p = new URL(request.url).searchParams;
  const status = p.get("status");
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) return NextResponse.json({ error: "bad_request", field: "status" }, { status: 400 });
  const rider = p.get("rider");
  if (rider && !isUuid(rider)) return NextResponse.json({ error: "bad_request", field: "rider" }, { status: 400 });
  const raw = p.get("cursor");
  const cursor = raw ? decodeTimeCursor(raw) : null;
  if (raw && (!cursor || !isUuid(cursor.id))) return NextResponse.json({ error: "bad_request", field: "cursor" }, { status: 400 });
  try {
    return NextResponse.json(
      await listExceptions(ctx.scope, { status: (status as (typeof STATUSES)[number]) || null, rider: rider ? rider.toLowerCase() : null, cursor }, ctx.permissions)
    );
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
