import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getInvoiceProfile } from "@/lib/data-access/vendor-store";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/invoice-profile — what the active shop's invoices and
 * receipts print about it: name, address, phone, GSTIN, FSSAI number.
 * → { profile }.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-money-read:${ctx.profile.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const profile = await getInvoiceProfile(ctx.restaurant.id);
    if (!profile) return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
    return NextResponse.json({ profile });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
