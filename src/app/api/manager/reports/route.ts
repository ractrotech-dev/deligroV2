import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { mayRun, reportMeta } from "@/lib/reports/definitions";
import { parseReportQuery } from "@/lib/reports/query";
import { runReport } from "@/lib/reports/registry";
import { financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/reports?kind&from&to&zone&vendor&rider&status&payment&page&pageSize&all=1
 * — one of the §13 reports in the manager's zones: columns, the page's rows,
 * totals over EVERY row of the filter, highlights, notes, and who generated it
 * when. `all=1` is the export (capped at 10 000 rows → 413 too_large with the
 * count). Finance columns are left out without manager.finance.view.
 *
 * Needs manager.reports.view, plus the kind's own permission (finance kinds:
 * finance.view; cash reconciliation: finance.view or manager.cash).
 * → 200 ReportPayload   → 400 bad_kind | bad_range | bad_filter | bad_request   → 403 permission_denied   → 413 too_large
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.reports.view");
  if (ctx instanceof Response) return ctx;

  const q = parseReportQuery(new URL(request.url).searchParams, new Date());
  if (!q.ok) {
    const { ok: _ok, ...rest } = q;
    void _ok;
    return NextResponse.json(rest, { status: 400 });
  }
  const isAdmin = ctx.profile.role === "admin";
  const def = reportMeta(q.kind);
  if (!mayRun(def, ctx.permissions, isAdmin)) {
    return NextResponse.json({ error: "permission_denied", permission: def.permission === "reports" ? "manager.reports.view" : "manager.finance.view" }, { status: 403 });
  }
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  try {
    const result = await runReport({
      ...q,
      scope: ctx.scope,
      canSeeFinance: isAdmin || ctx.permissions["manager.finance.view"] === true,
      generatedBy: { id: ctx.profile.id, name: ctx.profile.full_name?.trim() || "Manager" },
    });
    if ("error" in result) return NextResponse.json({ error: "too_large", rows: result.rows, max: 10_000 }, { status: 413 });
    return NextResponse.json(result);
  } catch {
    return loadFailed();
  }
}
