import { NextResponse } from "next/server";
import { vendorFeatureContext } from "@/lib/auth/vendor-api.server";
import { getCustomerInsights } from "@/lib/data-access/vendor-insights";
import { getVendorReviews } from "@/lib/data-access/vendor-reviews";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/reviews?days=90 — the shop's published reviews (newest
 * first, with its replies), the rating summary, the star breakdown, and
 * customer insights over the last `days` (30–365): customers, repeat rate,
 * orders per customer, days between orders, average order value, top
 * customers (short names only, never phone numbers).
 *
 * 403 feature_disabled when the shop's `vendor.reviews` switch is off.
 */
export async function GET(request: Request) {
  const ctx = await vendorFeatureContext("vendor.reviews");
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-growth-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const raw = Number(new URL(request.url).searchParams.get("days") ?? 90);
  const days = Number.isInteger(raw) && raw >= 30 && raw <= 365 ? raw : 90;
  try {
    const [reviews, insights] = await Promise.all([getVendorReviews(ctx.restaurant.id, 100), getCustomerInsights(ctx.restaurant.id, days)]);
    const stars = [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: reviews.reviews.filter((r) => r.rating === s).length }));
    return NextResponse.json({ ...reviews, stars, insights, days });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
