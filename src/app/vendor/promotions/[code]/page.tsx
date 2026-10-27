import { notFound } from "next/navigation";
import { requireVendorAccess } from "@/lib/auth/vendor-access";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { getPromotion } from "@/lib/data-access/promotions";
import { VendorPageHeader } from "@/components/vendor/vendor-page-header";
import { PromotionForm } from "@/components/promotions/promotion-form";
import { formatINR } from "@/lib/utils/format";
import { saveVendorPromotionAction } from "../actions";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { FeatureOffNotice } from "@/components/features/features-provider";

export const dynamic = "force-dynamic";

export default async function EditVendorPromotionPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  // Switchable in Admin → Feature access; the server actions behind this
  // page check the same switch.
  if (!(await vendorFeatureOn("vendor.promotions"))) return <FeatureOffNotice title="Promotions" />;
  await requireVendorAccess();
  const { code } = await params;
  const [restaurant, promotion] = await Promise.all([
    resolveVendorRestaurant(),
    getPromotion(decodeURIComponent(code)),
  ]);

  // Someone else's code reads as no code at all. The RLS policy already returns
  // nothing for it; this is what turns that into the right page. A code Deligro
  // funds on this shop is readable but not the vendor's to edit (0180).
  if (
    !restaurant ||
    !promotion ||
    promotion.restaurantId !== restaurant.id ||
    promotion.fundedBy !== "vendor"
  ) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <VendorPageHeader
        title={promotion.code}
        subtitle={`${promotion.redemptions} claimed · ${formatINR(
          promotion.discountGiven
        )} off customer bills`}
      />
      <PromotionForm
        action={saveVendorPromotionAction.bind(null, promotion.code)}
        promotion={promotion}
        fixedRestaurant={{ id: restaurant.id, name: restaurant.name }}
        cancelHref="/vendor/promotions"
      />
    </div>
  );
}
