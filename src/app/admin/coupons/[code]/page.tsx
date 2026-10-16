import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import {
  getPromotion,
  listPromotableRestaurants,
} from "@/lib/data-access/promotions";
import { AdminHero, BackLink } from "@/components/admin/admin-ui";
import { PromotionForm } from "@/components/promotions/promotion-form";
import { formatINR } from "@/lib/utils/format";
import { saveCouponAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function EditCouponPage({
  params,
}: Readonly<{
  params: Promise<{ code: string }>;
}>) {
  await requireRole("admin");
  const { code } = await params;
  const [promotion, restaurants] = await Promise.all([
    getPromotion(decodeURIComponent(code)),
    listPromotableRestaurants(),
  ]);
  if (!promotion) notFound();

  return (
    // Capped like every other form screen: a promo code's fields are a column
    // of labelled inputs, and a 1500px-wide text field is a worse form, not a
    // bigger one. (See `.admin-measure` in globals.css.)
    <div className="admin-measure space-y-4">
      <BackLink href="/admin/coupons">Promo codes</BackLink>
      <AdminHero
        title={promotion.code}
        tag={`${promotion.redemptions} claimed`}
        subtitle={`${formatINR(promotion.discountGiven)} given away · ${
          promotion.restaurantName ?? "every shop"
        }`}
      />
      <PromotionForm
        action={saveCouponAction.bind(null, promotion.code)}
        promotion={promotion}
        restaurants={restaurants}
        cancelHref="/admin/coupons"
      />
    </div>
  );
}
