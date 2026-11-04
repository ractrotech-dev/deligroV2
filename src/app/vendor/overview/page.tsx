import { VendorOverviewBoard } from "@/components/vendor/vendor-overview-board";
import { VendorPageHeader } from "@/components/vendor/vendor-page-header";
import { getProfile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import { getVendorOverviewSummary } from "@/lib/data-access/vendor-overview";
import type { VendorOverviewSummary } from "@/lib/data-access/vendor-overview";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { FeatureOffNotice } from "@/components/features/features-provider";

export const dynamic = "force-dynamic";

export default async function VendorOverviewPage() {
  // Switchable in Admin → Feature access; the server actions behind this
  // page check the same switch.
  if (!(await vendorFeatureOn("vendor.earnings"))) return <FeatureOffNotice title="Overview" />;
  // Its charts are the sales report in another place.
  if (!(await vendorFeatureOn("vendor.reports"))) return <FeatureOffNotice title="Overview" />;
  if (!isSupabaseConfigured) {
    return (
      <div className="space-y-6">
        <VendorPageHeader
          title="Overview"
          subtitle="Connect Supabase to view business insights."
        />
      </div>
    );
  }

  const profile = await getProfile();
  if (!(await hasVendorAccess(profile))) {
    return (
      <div className="space-y-6">
        <VendorPageHeader
          title="Overview"
          subtitle="Restaurant access required."
        />
      </div>
    );
  }

  let restaurant: Awaited<ReturnType<typeof resolveVendorRestaurant>> = null;
  try {
    restaurant = await resolveVendorRestaurant();
  } catch {
    return (
      <div className="space-y-6">
        <VendorPageHeader
          title="Overview"
          subtitle="Could not load your restaurant. Try again."
        />
      </div>
    );
  }

  if (!restaurant) {
    return (
      <div className="space-y-6">
        <VendorPageHeader
          title="Overview"
          subtitle="No restaurant linked to your account."
        />
      </div>
    );
  }

  let summary: VendorOverviewSummary;
  try {
    summary = await getVendorOverviewSummary(restaurant.id);
  } catch {
    return (
      <div className="space-y-6">
        <VendorPageHeader
          title="Overview"
          subtitle={`Could not load overview for ${restaurant.name}.`}
        />
      </div>
    );
  }

  return (
    <VendorOverviewBoard restaurantName={restaurant.name} stats={summary} />
  );
}
