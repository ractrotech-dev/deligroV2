import { requireUser } from "@/lib/auth";
import { ProfileSubpage } from "@/components/profile/profile-subpage";
import { FeatureOffNotice } from "@/components/features/features-provider";
import { customerFeatureOn } from "@/lib/features/guards.server";

export default async function AddressesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();
  if (!(await customerFeatureOn("customer.saved_addresses"))) {
    return (
      <ProfileSubpage title="Saved addresses">
        <FeatureOffNotice title="Saved addresses" />
      </ProfileSubpage>
    );
  }
  return children;
}
