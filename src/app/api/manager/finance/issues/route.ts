import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listFinanceIssues } from "@/lib/data-access/manager-finance";
import { parseFinanceRange } from "@/lib/ops/finance-contract";
import { FINANCE_ISSUE_TYPES, type FinanceIssueType } from "@/lib/ops/finance-rules";
import { badRequest, cursorParam, financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/finance/issues?type&from&to&zone&cursor — failed or delayed
 * transactions (§7 tracking 5), newest first. `from`/`to` bound
 * `failed_payment` only; the other six are current state. Thresholds are
 * src/lib/ops/finance-rules.ts (shared with the alert engine).
 *
 * Needs manager.finance.view.
 * → 200 { items: FinanceIssue[], nextCursor, counts }   → 400 bad_range | bad_request   → 403 permission_denied
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const now = new Date();
  const p = new URL(request.url).searchParams;
  const q = parseFinanceRange(p, now);
  if (!q.ok) return NextResponse.json({ error: q.error, ...(q.field ? { field: q.field } : {}) }, { status: 400 });
  const type = p.get("type");
  if (type && !FINANCE_ISSUE_TYPES.includes(type as FinanceIssueType)) return badRequest("type");
  const cursor = cursorParam(p);
  if (cursor instanceof Response) return cursor;

  try {
    const res = await listFinanceIssues(ctx.scope, { range: q.range, zone: q.zone, type: (type as FinanceIssueType) || null, cursor }, now);
    return NextResponse.json({ items: res.items, nextCursor: res.nextCursor, counts: res.counts });
  } catch {
    return loadFailed();
  }
}
