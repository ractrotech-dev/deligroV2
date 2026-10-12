import { requireRole } from "@/lib/auth";
import { notFound } from "next/navigation";
import { getVendorDetail } from "@/lib/data-access/admin-vendors";
import { listCategories } from "@/lib/data-access/vendor-categories";
import { getVendorCommissionDefault } from "@/lib/data-access/admin-commission";
import { AdminHero } from "@/components/admin/admin-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { VendorForm } from "./vendor-form";
import { VendorCredentials } from "./vendor-credentials";

export const dynamic = "force-dynamic";

export default async function EditVendorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { id } = await params;
  const [vendor, categories, platformCommissionPct] = await Promise.all([
    getVendorDetail(id),
    listCategories(),
    getVendorCommissionDefault(),
  ]);
  if (!vendor) notFound();

  return (
    <div className="admin-measure space-y-4">
      <AdminHero
        backHref={`/admin/vendors/${id}`}
        backLabel={vendor.name}
        title="Edit vendor"
        subtitle="Update shop details, credentials & status"
      />
      {/* Credentials stay on the phone on purpose: "I can't log in" is a support
          call, and support calls happen away from a desk. */}
      <VendorCredentials
        id={vendor.id}
        loginEmail={vendor.ownerEmail}
        loginPassword={vendor.loginPassword}
        passwordResetAt={vendor.passwordResetAt}
        ownerMobile={vendor.ownerMobile}
        ownerPhoneVerified={vendor.ownerPhoneVerified}
      />

      {/* Authoring shop details and overriding commission is console work.
          Suspending or reactivating a shop — the urgent half — is already a row
          action on /admin/vendors, so nothing time-critical is behind this. */}
      <ConsoleOnly
        tool="Editing vendor details"
        why="Resetting this owner's password, above, still works on a phone — and suspending the shop is a row action on the vendor list."
      >
        <VendorForm
          vendor={vendor}
          categories={categories.map((c) => c.name)}
          platformCommissionPct={platformCommissionPct}
        />
      </ConsoleOnly>
    </div>
  );
}
