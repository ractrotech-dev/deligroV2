import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { featuresFor, type FeatureKey } from "@/lib/features/catalog";
import { getFeatures } from "@/lib/features/flags.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/me — the Partner app's first call after sign-in.
 *
 * → { profile: { id, fullName, phone, role },
 *     shops: [{ id, slug, name, isOpen }],
 *     activeSlug,            // the shop the server will act on
 *     features }             // vendor.* switches for that shop
 *
 * `activeSlug` is the server's answer, not an echo of the cookie: a stale or
 * foreign `vendor_restaurant_slug` falls back to a shop this account owns, and
 * the app adopts whatever comes back.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  const { profile, restaurant, shops } = ctx;

  try {
    // Same rule as vendorFeatureOn: an admin is support, never switched off.
    const switches = await getFeatures("vendor", restaurant.id);
    const features = Object.fromEntries(
      featuresFor("vendor").map((f) => [
        f.key,
        profile.role === "admin" ? true : switches[f.key as FeatureKey],
      ])
    );

    return NextResponse.json({
      profile: {
        id: profile.id,
        fullName: profile.full_name,
        phone: profile.phone,
        role: profile.role,
      },
      shops: shops.map((s) => ({ id: s.id, slug: s.slug, name: s.name, isOpen: s.isOpen })),
      activeSlug: restaurant.slug,
      features,
    });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
