import { requireRole } from "@/lib/auth";
import { FeatureAccessScreen } from "@/components/admin/feature-access/feature-access-screen";
import { setFeatureSwitchAsAdminAction } from "./actions";

/**
 * Admin → Settings → Feature access. Where an admin grants a manager the
 * powers that start switched off (design: Permissions), and sets what vendors
 * and riders may use. Every change is written to the ops audit log with it.
 */
export const dynamic = "force-dynamic";

export default async function AdminFeatureAccessPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");
  return <FeatureAccessScreen save={setFeatureSwitchAsAdminAction} />;
}
