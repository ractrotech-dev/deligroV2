import type { MetadataRoute } from "next";
import { listPublicRestaurantSlugs } from "@/lib/data-access/restaurants";
import { RESTAURANTS } from "@/lib/data";
import { IS_INDEXABLE, SITE_URL } from "@/lib/site";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * The pages worth finding: the storefront, and one entry per approved
 * restaurant. Restaurant pages are the only real SEO asset a delivery business
 * owns — the queries that matter are "<dish> bemetara" and "<shop name>", and
 * they land here.
 *
 * Only ever lists what `listRestaurantsResult` returns, which is already scoped
 * to approved, publicly-readable shops by the same grants the storefront uses
 * (migration 0022). There is no second, laxer query here to keep in sync — a
 * sitemap that lists a shop the app will not render is a soft 404 to a crawler.
 *
 * Revalidated hourly rather than per request: a crawler hitting this should not
 * run a catalog query, and a new restaurant appearing within the hour is fast
 * enough for indexing.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Nothing to advertise from a staging host — robots.ts refuses it wholesale,
  // and an empty sitemap is the consistent answer.
  if (!IS_INDEXABLE) return [];

  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/stores`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/search`, lastModified: now, changeFrequency: "weekly", priority: 0.5 },
  ];

  let slugs: string[];
  try {
    slugs = isSupabaseConfigured
      ? (await listPublicRestaurantSlugs()).map((r) => r.slug)
      : RESTAURANTS.map((r) => r.slug);
  } catch (err) {
    // A failed read and "this city has no restaurants" produce the same empty
    // array and are nothing alike. Publishing the empty one would drop every
    // shop from the index on the strength of one bad query, so emit the static
    // routes alone and let the existing entries age out naturally instead.
    console.error("[sitemap] restaurant read failed — omitting shop entries", err);
    return staticRoutes;
  }

  return [
    ...staticRoutes,
    ...slugs.map((slug) => ({
      url: `${SITE_URL}/restaurant/${slug}`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.9,
    })),
  ];
}
