import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { getFinanceOverview } from "@/lib/data-access/manager-finance";
import { parseFinanceRange } from "@/lib/ops/finance-contract";
import { financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/overview?from&to&zone — the §7 Finance overview:
 * the nine sales & commission figures and the payment-tracking figures, in the
 * manager's zones. Money from migration 0157's rollups (the SQL mirror of
 * src/lib/metrics). `vendorPaid`/`riderPaid` are paid within the range; dues
 * and payables are as of now.
 *
 * Needs manager.finance.view.
 * → 200 FinanceOverview   → 400 bad_range | bad_request   → 403 permission_denied   → 429
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const now = new Date();
  const q = parseFinanceRange(new URL(request.url).searchParams, now);
  if (!q.ok) return NextResponse.json({ error: q.error, ...(q.field ? { field: q.field } : {}) }, { status: 400 });

  try {
    return NextResponse.json(await getFinanceOverview(ctx.scope, { range: q.range, zone: q.zone }, now));
  } catch {
    return loadFailed();
  }
}
