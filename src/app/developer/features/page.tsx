import { requireRole } from "@/lib/auth";
import { FeatureAccessScreen } from "@/components/admin/feature-access/feature-access-screen";
import { setFeatureSwitchAction } from "./actions";

/**
 * Developer → Feature access. The same screen as Admin → Feature access; this
 * copy saves through the developer-gated action.
 */
export const dynamic = "force-dynamic";

export default async function FeatureAccessPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("developer");
  return <FeatureAccessScreen save={setFeatureSwitchAction} />;
}
