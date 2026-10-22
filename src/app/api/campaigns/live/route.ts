import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { activeFeaturedCampaigns, activeSponsoredItems } from "@/lib/data-access/manager-marketing";

/**
 * GET /api/campaigns/live — the paid placements live right now (0160), for
 * clients that read the catalog straight from the database (the Flutter
 * customer app): featured shops with their slot, and sponsored dishes.
 * Public on purpose — it is exactly what the storefront already shows, with
 * its "Featured" / "Sponsored" labels — and decided from each campaign's
 * window, never its stored status. Cached 60 s server-side.
 *
 * → 200 { featured: [{ campaignId, restaurantId, slot }], sponsored: [{ campaignId, menuItemId }] }
 */
export async function GET() {
  if (!isSupabaseConfigured) return NextResponse.json({ featured: [], sponsored: [] });
  const now = new Date();
  const [featured, sponsored] = await Promise.all([
    activeFeaturedCampaigns(now).catch(() => []),
    activeSponsoredItems(now).catch(() => new Map<string, string>()),
  ]);
  return NextResponse.json(
    {
      featured: featured.map((f) => ({ campaignId: f.campaignId, restaurantId: f.restaurantId, slot: f.slot })),
      sponsored: [...sponsored].map(([menuItemId, campaignId]) => ({ campaignId, menuItemId })),
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}
