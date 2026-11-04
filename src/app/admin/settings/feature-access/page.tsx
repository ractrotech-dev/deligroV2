import { requireRole } from "@/lib/auth";
import { FeatureAccessScreen } from "@/components/admin/feature-access/feature-access-screen";
import {
  loadAccountSwitchesAsAdminAction,
  searchFeatureAccountsAsAdminAction,
  setFeatureSwitchAsAdminAction,
} from "./actions";

/**
 * Admin → App features: what customers, shops, riders and managers can use, for
 * everyone or for one account, including the manager powers that start switched
 * off. Every change is written to the ops audit log with it.
 *
 * WEB. Admin is desktop only. The old name's URL stays, so links keep working.
 * `?role=manager&account=<id>` opens one account (the Team list links here).
 */
export const dynamic = "force-dynamic";

export default async function AdminFeatureAccessPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ role?: string; account?: string }> }>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");
  const { role, account } = await searchParams;
  return (
    <FeatureAccessScreen
      initialRole={role}
      initialAccountId={account}
      actions={{
        save: setFeatureSwitchAsAdminAction,
        search: searchFeatureAccountsAsAdminAction,
        loadAccount: loadAccountSwitchesAsAdminAction,
      }}
    />
  );
}
