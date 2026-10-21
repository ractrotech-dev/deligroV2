import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { narrowScope } from "@/lib/auth/manager-scope";
import {
  loadDashboardCounts,
  loadMetricOrders,
  loadPaidOrderIds,
  loadPricing,
  loadRefunds,
} from "@/lib/data-access/ops-metrics";
import { computeDashboard } from "@/lib/metrics/dashboard";
import { dashboardPayload } from "@/lib/manager/dashboard-payload";

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
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const zone = new URL(request.url).searchParams.get("zone");
  const scope = narrowScope(ctx.scope, zone);
  const now = new Date();

  try {
    const [orders, paidOrderIds, { counts, unavailable }] = await Promise.all([
      loadMetricOrders(scope),
      loadPaidOrderIds(scope),
      loadDashboardCounts(scope, now),
    ]);
    const [refunds, pricing] = await Promise.all([
      loadRefunds(orders.map((o) => o.id)),
      loadPricing(orders.map((o) => o.restaurantId)),
    ]);
    const dashboard = computeDashboard(orders, { now, refunds, pricing, paidOrderIds, counts });
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
