import { MapPinned } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { AdminHero, EmptyState, PreviewNotice } from "@/components/admin/admin-ui";
import { Figure, FigureRow } from "@/components/admin/console";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { listCitiesWithZones, type CityZones } from "@/lib/data-access/zones";
import { ZonesManager } from "./zones-manager";

/**
 * Settings → Zones. The cities Deligro runs in and the delivery zones inside
 * them (migration 0141). Managers are scoped to zones: a manager sees the
 * orders, riders and money of the zones assigned to them on the Team screen,
 * and nothing else.
 */
export const dynamic = "force-dynamic";

export default async function AdminZonesPage() {
  await requireRole("admin");

  let cities: CityZones[] = [];
  let missing = false;
  if (isSupabaseConfigured) {
    try {
      cities = await listCitiesWithZones();
    } catch {
      missing = true;
    }
  }
  const zones = cities.flatMap((c) => c.zones);

  return (
    <>
      <AdminHero
        backHref="/admin/settings"
        backLabel="Settings"
        title="Zones"
        tag={`${zones.length} zone${zones.length === 1 ? "" : "s"}`}
        subtitle="Cities and delivery zones. Managers see only the zones you assign them on Team."
      />

      {!isSupabaseConfigured ? <PreviewNotice>Connect Supabase to manage zones.</PreviewNotice> : null}

      {missing ? (
        <EmptyState
          icon={MapPinned}
          title="Zones aren't set up yet"
          description="Apply migration 0141 to create cities and delivery zones."
        />
      ) : (
        <>
          <FigureRow>
            <Figure label="Cities" value={cities.length} note="Where Deligro operates" />
            <Figure label="Zones" value={zones.length} note={`${zones.filter((z) => z.isActive).length} active`} />
          </FigureRow>
          <ZonesManager cities={cities} disabled={!isSupabaseConfigured} />
        </>
      )}
    </>
  );
}
