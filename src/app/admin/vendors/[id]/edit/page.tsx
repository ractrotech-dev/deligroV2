import { requireRole } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getVendorDetail } from "@/lib/data-access/admin-vendors";
import { listCategories } from "@/lib/data-access/vendor-categories";
import { getVendorCommissionDefault } from "@/lib/data-access/admin-commission";
import { AdminHero } from "@/components/admin/admin-ui";
import { listCitiesWithZones } from "@/lib/data-access/zones";
import { VendorForm } from "./vendor-form";

export const dynamic = "force-dynamic";

export default async function EditVendorPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { id } = await params;
  const [vendor, categories, platformCommissionPct, cities] = await Promise.all([
    getVendorDetail(id),
    listCategories(),
    getVendorCommissionDefault(),
    listCitiesWithZones().catch(() => []),
  ]);
  if (!vendor) notFound();

  // Zones that are on, plus the one the shop is in now even if it was switched off.
  const areas = cities.flatMap((c) =>
    c.zones
      .filter((z) => z.isActive || z.id === vendor.zoneId)
      .map((z) => ({ id: z.id, label: cities.length > 1 ? `${c.name} · ${z.name}` : z.name }))
  );

  return (
    <div className="admin-measure space-y-4">
      <AdminHero
        backHref={`/admin/vendors/${id}`}
        backLabel={vendor.name}
        title="Edit vendor"
        subtitle="Change this shop's details, photo and map pin."
      />

      {/* Authoring shop details and overriding commission is console work.
          Suspending or reactivating a shop — the urgent half — is already a row
          action on /admin/vendors, so nothing time-critical is behind this. */}
      <VendorForm
        vendor={vendor}
        categories={categories.map((c) => c.name)}
        platformCommissionPct={platformCommissionPct}
        areas={areas}
      />
    </div>
  );
}
