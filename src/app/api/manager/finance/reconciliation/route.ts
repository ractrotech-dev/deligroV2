import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { getReconciliation } from "@/lib/data-access/manager-finance";
import { parseReconciliationQuery, reconciliationPermission } from "@/lib/ops/reconciliation-query";
import { financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/reconciliation?section=orders|online|cash&from&to&zone&state&cursor
 * (§7 tracking 9):
 *   orders — every delivered order in range against the settlement line that
 *            paid it: matched, mismatched (and by how much), covered by an
 *            outstanding correction, in a draft, unsettled and due, recent;
 *   online — online-paid orders whose captured payment differs from the total;
 *   cash   — per rider × IST day, COD collected vs deposited (and disputes);
 *            per manager × day, received vs handed on.
 *
 * orders/online need manager.finance.view; cash needs finance.view OR manager.cash.
 * → 200 ReconciliationPayload   → 400 bad_range | bad_request   → 403 permission_denied
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const now = new Date();
  const q = parseReconciliationQuery(new URL(request.url).searchParams, now);
  if (!q.ok) return NextResponse.json({ error: q.error, ...(q.field ? { field: q.field } : {}) }, { status: 400 });

  const missing = reconciliationPermission(q.section, ctx.permissions, ctx.profile.role === "admin");
  if (missing) return NextResponse.json({ error: "permission_denied", permission: missing }, { status: 403 });
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  try {
    return NextResponse.json(await getReconciliation(ctx.scope, { section: q.section, range: q.range, zone: q.zone, state: q.state, cursor: q.cursor }, now));
  } catch {
    return loadFailed();
  }
}
