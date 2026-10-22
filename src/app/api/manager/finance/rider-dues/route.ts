import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listRiderDues } from "@/lib/data-access/manager-finance";
import { badRequest, cursorParam, financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/rider-dues?zone&delayed=1&cursor — unpaid rider
 * ledger per rider in the manager's zones (riders are salaried: recorded
 * salary not yet paid, plus any other unpaid ledger rows), largest first;
 * `delayed=1` keeps riders unpaid for over 35 days. Money with 2 decimals.
 *
 * Needs manager.finance.view.
 * → 200 { items: RiderDue[], nextCursor, totals: { payable, count } }   → 400 bad_request   → 403 permission_denied
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const p = new URL(request.url).searchParams;
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return badRequest("zone");
  const cursor = cursorParam(p);
  if (cursor instanceof Response) return cursor;

  try {
    return NextResponse.json(
      await listRiderDues(ctx.scope, { zone: zone ? zone.toLowerCase() : null, delayedOnly: p.get("delayed") === "1", cursor }, new Date())
    );
  } catch {
    return loadFailed();
  }
}
