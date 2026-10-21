import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { narrowScope } from "@/lib/auth/manager-scope";
import { loadDashboard } from "@/lib/data-access/ops-metrics";
import { dashboardPayload } from "@/lib/manager/dashboard-payload";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/dashboard?zone=<uuid> — the eighteen figures of §1.
 *
 * → 200 DashboardPayload (src/lib/manager/dashboard-payload.ts): the figures in
 *   the document's order; fee, commission and payment-due figures only with
 *   `manager.finance.view`; a figure the platform cannot count yet is `null`
 *   and listed in `unavailable`.
 *
 * Read-only. Every read is the service role behind managerApiContext(),
 * limited to the caller's zones — or one of them, with `zone`. A zone that is
 * not theirs narrows to nothing (all zeros), never to everything. A failed
 * orders read is 500 `load_failed`: zeros would be a figure someone acts on.
 *
 * The figures are summed in Postgres (`ops_dashboard_rollup`, 0144) and shared
 * for 20 s between callers with the same zones. Rate-limited per user (60 a
 * minute — two a minute is the app's own pace): an expensive read is still a
 * read someone can hammer.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`manager-dashboard:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const zone = new URL(request.url).searchParams.get("zone");
  const scope = narrowScope(ctx.scope, zone);
  const now = new Date();

  try {
    const { dashboard, unavailable } = await loadDashboard(scope, now);
    return NextResponse.json(
      dashboardPayload(dashboard, {
        canSeeFinance: ctx.permissions["manager.finance.view"] === true,
        unavailable,
        zone: zone || null,
        now,
      })
    );
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
