import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listRefundsFor } from "@/lib/data-access/manager-finance";
import { parseFinanceRange } from "@/lib/ops/finance-contract";
import { badRequest, cursorParam, financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "denied"] as const;

/**
 * GET /api/manager/finance/refunds?status&from&to&zone&cursor — refund
 * requests on orders in the manager's zones (§7 sales 5, §10.5). Pending
 * oldest first (a queue); decided newest first. No range = all time.
 *
 * Needs manager.finance.view.
 * → 200 { items: RefundItem[], nextCursor, counts: { pending } }   → 400   → 403
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const p = new URL(request.url).searchParams;
  const status = p.get("status");
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) return badRequest("status");
  let range = null;
  let zone: string | null = null;
  if (p.has("from") || p.has("to")) {
    const q = parseFinanceRange(p, new Date());
    if (!q.ok) return NextResponse.json({ error: q.error, ...(q.field ? { field: q.field } : {}) }, { status: 400 });
    range = q.range;
    zone = q.zone;
  } else {
    zone = p.get("zone");
    if (zone && !isUuid(zone)) return badRequest("zone");
  }
  const cursor = cursorParam(p);
  if (cursor instanceof Response) return cursor;

  try {
    return NextResponse.json(await listRefundsFor(ctx.scope, {
      status: (status as (typeof STATUSES)[number]) || null,
      range,
      zone: zone ? zone.toLowerCase() : null,
      cursor,
    }));
  } catch {
    return loadFailed();
  }
}
