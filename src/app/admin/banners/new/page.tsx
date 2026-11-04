import { AdminHero } from "@/components/admin/admin-ui";
import { BannerForm } from "../banner-form";

export const dynamic = "force-dynamic";

export default function NewBannerPage() {
  return (
    <div className="admin-measure space-y-6">
      <AdminHero
        backHref="/admin/banners"
        backLabel="Campaigns"
        title="New campaign"
        subtitle="Design a banner or sponsored ad for the customer app"
      />
      <BannerForm />
    </div>
  );
}
