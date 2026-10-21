import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getVendorPayments } from "@/lib/data-access/vendor-payments";
import { featureOffResponse, vendorFeatureOn } from "@/lib/features/guards.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/payments — the shop's money (requirements §4): total
 * earnings, amount settled, payment due (signed: negative = the shop owes
 * Deligro for cash it kept), paid / unpaid / partly paid counts, settlement
 * history (paid and voided; never drafts) and the unpaid orders behind the
 * payment due. Follows the shop's Earnings switch.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  if (!(await vendorFeatureOn("vendor.earnings"))) return featureOffResponse("vendor.earnings");

  const limit = await rateLimit(`vendor-money-read:${ctx.profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const payments = await getVendorPayments(ctx.restaurant.id);
    if (!payments) return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
    return NextResponse.json(payments);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
