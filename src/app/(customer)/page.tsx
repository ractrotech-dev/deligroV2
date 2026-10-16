import type { Metadata } from "next";
import { HomeView } from "@/components/home/home-view";
import { dailyRotationSeed } from "@/lib/search/rotation";
import { listRestaurantsResult } from "@/lib/catalog";
import { getHomeCategories } from "@/lib/categories";
import { listActiveBanners } from "@/lib/banners";
import { getActiveOrderForHome } from "@/lib/orders-ui";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listAddresses } from "@/lib/data-access/addresses";
import { ADDRESSES } from "@/lib/data";

// Title and description come from the root layout; only the canonical is
// page-specific, so `/?utm_…` and similar variants fold into one URL.
export const metadata: Metadata = { alternates: { canonical: "/" } };

export default async function HomePage() {
  // All independent — none of these depend on another's result — so they run
  // as one parallel batch instead of `listAddresses()` waiting behind it as a
  // separate round trip.
  const [catalog, activeOrder, banners, categories, addrs] = await Promise.all([
    // RestaurantCard (the only thing this page renders restaurants through)
    // never reads menu data — see listRestaurantsFromDb's doc comment.
    listRestaurantsResult({ withMenu: false }),
    // Only the in-flight order: Home draws one strip, not a history.
    getActiveOrderForHome(),
    // The home carousel: whatever campaigns the Admin Panel has running here.
    listActiveBanners("home_hero"),
    // Cuisine strip. Curated pictures, with any an operator has replaced.
    getHomeCategories(),
    isSupabaseConfigured ? listAddresses().catch(() => []) : Promise.resolve(ADDRESSES),
  ]);

  const def = addrs.find((a) => a.isDefault) ?? addrs[0];
  // Demo-mode addresses carry no pin, so the coordinates are optional here.
  const pin = def as { lat?: number | null; lng?: number | null } | undefined;
  const savedAddress = def
    ? {
        label: def.label,
        line: def.line,
        lat: pin?.lat ?? null,
        lng: pin?.lng ?? null,
      }
    : null;

  const { restaurants } = catalog;
  const popular = [...restaurants]
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 6);
  const nearby = [...restaurants].sort((a, b) => a.etaMin - b.etaMin);

  return (
    <HomeView
      savedAddress={savedAddress}
      restaurants={restaurants}
      activeOrder={activeOrder}
      banners={banners}
      popular={popular}
      nearby={nearby}
      categories={categories}
      // A failed catalog read must not render as "no shops near you" — the
      // storefront says it couldn't load instead of describing the city.
      catalogFailed={!catalog.ok}
      rotationSeed={dailyRotationSeed()}
    />
  );
}
