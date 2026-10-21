import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listCashDeposits } from "@/lib/data-access/manager-cash";
import { decodeTimeCursor } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

const STATUSES = ["submitted", "confirmed", "disputed", "withdrawn"] as const;

/**
 * GET /api/manager/cash/deposits — cash deposits riders in the manager's zones
 * declared (§5.14). Query: status (submitted = the queue, oldest first; others
 * newest first), rider, cursor. Needs manager.cash.
 *
 * → 200 { items: CashDeposit[], nextCursor, counts: { submitted } }   → 400 bad_request
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.cash");
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
      await listCashDeposits(ctx.scope, { status: (status as (typeof STATUSES)[number]) || null, rider: rider ? rider.toLowerCase() : null, cursor })
    );
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
