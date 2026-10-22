import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { isDraftStale } from "@/lib/data-access/admin-settlements";
import { getSettlementFor } from "@/lib/data-access/manager-finance";
import { getPaymentRequest } from "@/lib/data-access/payment-requests";
import { viewerOf } from "@/lib/data-access/manager-riders";
import { financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/settlements/[id] — one settlement with its lines,
 * corrections, its payment request (Phase 5 shape) and `checks`: whether a
 * refund made a draft stale since it was built, and what it would be if
 * rebuilt now. Out of the manager's zones → 404.
 *
 * Needs manager.finance.view.
 * → 200 { settlement, lines, corrections, request, checks: { stale, freshNetPayable } }   → 403   → 404
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const found = await getSettlementFor(ctx.scope, id.toLowerCase(), isDraftStale);
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const request = found.requestId ? await getPaymentRequest(ctx.scope, found.requestId, viewerOf(ctx)) : null;
    return NextResponse.json({
      settlement: found.settlement,
      lines: found.lines,
      corrections: found.corrections,
      request,
      checks: found.checks,
    });
  } catch {
    return loadFailed();
  }
}
