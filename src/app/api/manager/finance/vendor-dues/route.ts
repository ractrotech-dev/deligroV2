import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listVendorDues } from "@/lib/data-access/manager-finance";
import { badRequest, cursorParam, financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/vendor-dues?zone&delayed=1&cursor — what each shop
 * in the manager's zones is owed as of now (delivered orders not in a paid
 * settlement), largest first; `delayed=1` keeps the overdue ones (cycle + 3
 * days, finance-rules). A shop that owes Deligro shows under `recoverable`.
 *
 * Needs manager.finance.view.
 * → 200 { items: VendorDue[], nextCursor, totals: { payable, count } }   → 400 bad_request   → 403 permission_denied
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
      await listVendorDues(ctx.scope, { zone: zone ? zone.toLowerCase() : null, delayedOnly: p.get("delayed") === "1", cursor }, new Date())
    );
  } catch {
    return loadFailed();
  }
}
