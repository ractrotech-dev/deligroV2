import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getRiderLedger } from "@/lib/data-access/manager-riders";
import { parseLedgerQuery } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders/[id]/ledger — the rider's pay ledger and payouts
 * (§5.13): earnings, incentives, salary, bonuses, deductions and adjustments,
 * each pending or paid, with the payouts that paid them. Riders are salaried:
 * salary rows come from approved payout requests.
 *
 * Needs manager.riders.view AND manager.finance.view.
 * Query: from, to (IST dates), status (pending | paid), cursor.
 *
 * → 200 { items: LedgerRow[], nextCursor, payouts: Payout[], summary }
 * → 400 { error: "bad_request", field }   → 403 permission_denied   → 404 not_found
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.permissions["manager.finance.view"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.finance.view" }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseLedgerQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    const page = await getRiderLedger(ctx.scope, id.toLowerCase(), parsed.query);
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(page);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
