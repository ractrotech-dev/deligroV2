import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listRiderPayouts } from "@/lib/data-access/manager-finance";
import { parseFinanceRange } from "@/lib/ops/finance-contract";
import { badRequest, cursorParam, financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/rider-payouts?from&to&rider&zone&cursor — rider
 * payouts made (by paid_on) to riders in the manager's zones, newest first
 * (§7 tracking 4). Riders are salaried: these are the recorded salary payouts.
 *
 * Needs manager.finance.view.
 * → 200 { items, nextCursor, totals: { amount, count } }   → 400 bad_range | bad_request   → 403 permission_denied
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const p = new URL(request.url).searchParams;
  const q = parseFinanceRange(p, new Date());
  if (!q.ok) return NextResponse.json({ error: q.error, ...(q.field ? { field: q.field } : {}) }, { status: 400 });
  const rider = p.get("rider");
  if (rider && !isUuid(rider)) return badRequest("rider");
  const cursor = cursorParam(p);
  if (cursor instanceof Response) return cursor;

  try {
    return NextResponse.json(await listRiderPayouts(ctx.scope, { range: q.range, zone: q.zone, riderId: rider ? rider.toLowerCase() : null, cursor }));
  } catch {
    return loadFailed();
  }
}
