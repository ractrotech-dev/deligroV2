import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getVendorStatement } from "@/lib/data-access/vendor-payments";
import { featureOffResponse, vendorFeatureOn } from "@/lib/features/guards.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isUuid } from "@/lib/vendor/uuid";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/payments/settlements/:id — one settlement statement of the
 * active shop: totals, the terms it was computed with, every order line, and
 * where it was paid (masked). 404 for another shop's or a draft.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  if (!(await vendorFeatureOn("vendor.earnings"))) return featureOffResponse("vendor.earnings");

  const limit = await rateLimit(`vendor-money-read:${ctx.profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const statement = await getVendorStatement(ctx.restaurant.id, id);
    if (!statement) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ statement });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
