import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getVendorDashboard } from "@/lib/data-access/vendor-dashboard";
import { vendorFeatureOn } from "@/lib/features/guards.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/dashboard — the Partner app's home figures for the active
 * shop (client requirements §1). Money follows the shop's Earnings switch, like
 * the web earnings page: off → `money: null` and zero sales. Marketing counts follow
 * its Marketing switch.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  try {
    const [includeMoney, includeMarketing] = await Promise.all([
      vendorFeatureOn("vendor.earnings"),
      vendorFeatureOn("vendor.marketing"),
    ]);
    return NextResponse.json(await getVendorDashboard(ctx.restaurant.id, { includeMoney, includeMarketing }));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
