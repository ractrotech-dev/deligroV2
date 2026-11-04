import { MapPinned } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { PageHeader } from "@/components/admin/console";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listCitiesWithZones, zoneCounts, type CityZones, type ZoneCounts } from "@/lib/data-access/zones";
import { getSettingsSnapshot } from "@/lib/settings";
import { ZonesManager } from "./zones-manager";

/**
 * Settings → Delivery radius and zones. The URL keeps its old name, so links
 * that exist keep working.
 *
 * Two different things, and the page has to keep them apart:
 *
 * - The delivery radius (`platform_settings.delivery_radius_km`) is what decides
 *   whether a customer can order: one circle around the city centre, enforced by
 *   `lib/geo/service-area.ts` and `order_address_in_service_area` (0181).
 * - Zones (migration 0141) group shops, orders and staff. A manager sees the
 *   orders, riders and money of the zones assigned to them on Team, and nothing
 *   else. A zone's own radius refuses nobody, and the page says so.
 */
export const dynamic = "force-dynamic";

export default async function AdminZonesPage() {
  await requireRole("admin");

  let cities: CityZones[] = [];
  let counts: Map<string, ZoneCounts> | null = null;
  let missing = false;
  if (isSupabaseConfigured) {
    try {
      cities = await listCitiesWithZones();
    } catch {
      missing = true;
    }
    if (!missing) {
      // Only the figures in the table depend on this: a failed count shows a
      // dash rather than taking the zones away.
      counts = await zoneCounts(cities.flatMap((c) => c.zones.map((z) => z.id))).catch(() => null);
    }
  }

  // During an outage the snapshot holds fallback values, not the saved radius:
  // showing one as if it were real would invite saving over it.
  const snapshot = await getSettingsSnapshot();
  const radiusKm = snapshot.source === "unavailable" ? null : snapshot.settings.deliveryRadiusKm;

  return (
    <>
      <PageHeader
        back={{ href: "/admin/settings", label: "Settings" }}
        title="Delivery radius and zones"
        description="How far Deligro delivers, and how shops and staff are grouped."
      />

      {!isSupabaseConfigured ? <PreviewNotice>Connect Supabase to manage these.</PreviewNotice> : null}

      {missing ? (
        <EmptyState
          icon={MapPinned}
          title="Zones aren't set up yet"
          description="Apply migration 0141 to create cities and delivery zones."
        />
      ) : (
        <ZonesManager
          cities={cities}
          counts={counts ? Object.fromEntries(counts) : null}
          radiusKm={radiusKm}
          disabled={!isSupabaseConfigured}
        />
      )}
    </>
  );
}
