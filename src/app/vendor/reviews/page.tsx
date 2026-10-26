import { VendorPageHeader } from "@/components/vendor/vendor-page-header";
import { VendorReviewsBoard } from "@/components/vendor/vendor-reviews-board";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { getVendorReviews, type VendorReviewsData } from "@/lib/data-access/vendor-reviews";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { FeatureOffNotice } from "@/components/features/features-provider";

export const dynamic = "force-dynamic";

function Notice({ subtitle }: { subtitle: string }) {
  return (
    <div className="space-y-6">
      <VendorPageHeader title="Reviews" subtitle={subtitle} />
    </div>
  );
}

/**
 * What customers said about the shop, with a place to answer them.
 *
 * Read-only apart from the reply, which is the one thing a vendor may write
 * about a review. A vendor cannot hide, report or delete a customer's review
 * from here: moderation stays with the admin console.
 */
export default async function VendorReviewsPage() {
  if (!isSupabaseConfigured) return <Notice subtitle="Connect Supabase to view reviews." />;

  const profile = await getProfile();
  if (!(await hasVendorAccess(profile))) return <Notice subtitle="Restaurant access required." />;
  // Switchable per shop in Admin → Feature access; the reply action and
  // /api/vendor/reviews refuse too.
  if (!(await vendorFeatureOn("vendor.reviews"))) return <FeatureOffNotice title="Reviews" />;

  let restaurant: Awaited<ReturnType<typeof resolveVendorRestaurant>> = null;
  try {
    restaurant = await resolveVendorRestaurant();
  } catch {
    return <Notice subtitle="Could not load your restaurant. Try again." />;
  }
  if (!restaurant) return <Notice subtitle="No restaurant linked to your account." />;

  let data: VendorReviewsData;
  try {
    data = await getVendorReviews(restaurant.id);
  } catch {
    return <Notice subtitle={`Could not load reviews for ${restaurant.name}. Try again.`} />;
  }

  return (
    <div className="space-y-6">
      <VendorPageHeader
        title="Reviews"
        subtitle={`What customers say about ${restaurant.name}.`}
      />
      <VendorReviewsBoard
        average={data.average}
        count={data.count}
        reviews={data.reviews}
        hasMore={data.hasMore}
      />
    </div>
  );
}
