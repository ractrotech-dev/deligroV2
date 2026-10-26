import { NextResponse } from "next/server";
import { vendorFeatureContext } from "@/lib/auth/vendor-api.server";
import { getVendorReport } from "@/lib/data-access/vendor-payments";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { parseReportFilters, parseReportRange } from "@/lib/vendor/report";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&status=all|completed|cancelled|in_progress
 *   &payment=all|cod|online&settled=all|settled|unsettled
 *
 * The sales report (requirements §5): every order in the IST date range with
 * its sale, discount, charges, earnings and settlement, plus totals. The app
 * builds CSV / Excel / PDF from this. Range defaults to this month, at most a
 * year. Money columns are null when the shop's Earnings switch is off; the
 * whole report is refused (403 feature_disabled) when its Reports switch is.
 */
export async function GET(request: Request) {
  const ctx = await vendorFeatureContext("vendor.reports");
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-report:${ctx.profile.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const q = new URL(request.url).searchParams;
  const range = parseReportRange(q.get("from"), q.get("to"));
  if (!range) return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  const filters = parseReportFilters(q);
  if (!filters) return NextResponse.json({ error: "invalid_filter" }, { status: 400 });

  try {
    const includeMoney = await vendorFeatureOn("vendor.earnings");
    const report = await getVendorReport(ctx.restaurant.id, range, filters, includeMoney);
    return NextResponse.json({ from: range.fromDay, to: range.toDay, filters, shop: ctx.restaurant.name, ...report });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
