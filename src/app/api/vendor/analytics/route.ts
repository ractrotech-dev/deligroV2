import { NextResponse } from "next/server";
import { vendorFeatureContext } from "@/lib/auth/vendor-api.server";
import { getVendorAnalytics } from "@/lib/data-access/vendor-analytics";
import { featureOffResponse, vendorFeatureOn } from "@/lib/features/guards.server";
import { analyticsWindow } from "@/lib/vendor/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/analytics?granularity=day|week|month|year|custom[&from=&to=]
 * Sales statistics for the active shop (client requirements §2). Custom
 * ranges are YYYY-MM-DD, inclusive, at most 366 days, not in the future.
 * Gated by the shop's Reports switch (the app's Reports tab) and its Earnings
 * switch, like the web overview.
 */
export async function GET(request: Request) {
  const ctx = await vendorFeatureContext("vendor.reports");
  if (ctx instanceof Response) return ctx;
  if (!(await vendorFeatureOn("vendor.earnings"))) return featureOffResponse("vendor.earnings");

  const url = new URL(request.url);
  const window = analyticsWindow(url.searchParams.get("granularity") ?? "day", new Date(), {
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });
  if ("error" in window) return NextResponse.json({ error: window.error }, { status: 400 });

  try {
    return NextResponse.json(await getVendorAnalytics(ctx.restaurant.id, window));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
