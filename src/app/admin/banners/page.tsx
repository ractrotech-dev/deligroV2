import { requireRole } from "@/lib/auth";
import { listAllBanners, bannersBackendReady } from "@/lib/banners";
import { getBannerActivity } from "@/lib/data-access/banners";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { CampaignsView } from "./campaigns-view";

/** Admin → Campaigns & ads. The screen itself is CampaignsView. */
export const dynamic = "force-dynamic";

export default async function AdminBannersPage() {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const [banners, backendReady, activity] = await Promise.all([
    listAllBanners(),
    bannersBackendReady(),
    isSupabaseConfigured ? getBannerActivity() : null,
  ]);

  return <CampaignsView banners={banners} backendReady={backendReady} activity={activity} now={new Date()} />;
}
