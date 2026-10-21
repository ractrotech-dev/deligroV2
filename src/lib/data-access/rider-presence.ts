import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { RIDER_PRESENCE_MS } from "@/lib/rider/availability";
import { isMissingTable } from "@/lib/data-access/schema-probe";

/**
 * Where one rider stands right now, from `rider_status` (0081): in a shift or
 * not, and the position their phone last reported.
 *
 * Kept in its own module because three callers need exactly this and two of
 * them cannot import each other (`driver-orders` is imported by `rider-status`).
 * The caller authorises: every call passes a rider id taken from the session.
 */
export interface RiderPresence {
  /** In a shift (a break still counts: the rider is working, just paused). */
  online: boolean;
  /**
   * The last reported position, only while it is fresh (RIDER_PRESENCE_MS). An
   * older fix is history, not a location; recording it as "where the rider
   * was when they tapped" would be a small lie in the audit trail.
   */
  position: { lat: number; lng: number } | null;
  /** When that position arrived, ISO (set whenever `position` is). */
  fixAt: string | null;
}

interface PresenceRow {
  is_online: boolean;
  last_lat: number | null;
  last_lng: number | null;
  last_fix_at: string | null;
}

/**
 * Null when `rider_status` does not exist (a database without 0081): there is
 * nobody to ask, and each caller decides what that means (the app's routes fail
 * closed; the web portal keeps its old behaviour). Any other failure throws —
 * an unreadable presence table must never read as "online".
 */
export async function readRiderPresence(
  driverId: string,
  now: number = Date.now()
): Promise<RiderPresence | null> {
  const { data, error } = await createAdminClient()
    .from("rider_status")
    .select("is_online, last_lat, last_lng, last_fix_at")
    .eq("driver_id", driverId)
    .maybeSingle()
    .overrideTypes<PresenceRow>();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  if (!data || !data.is_online) return { online: false, position: null, fixAt: null };

  const at = data.last_fix_at ? Date.parse(data.last_fix_at) : Number.NaN;
  const fresh =
    Number.isFinite(at) &&
    Math.abs(now - at) < RIDER_PRESENCE_MS &&
    typeof data.last_lat === "number" &&
    typeof data.last_lng === "number" &&
    Number.isFinite(data.last_lat) &&
    Number.isFinite(data.last_lng);
  return {
    online: true,
    position: fresh ? { lat: data.last_lat as number, lng: data.last_lng as number } : null,
    fixAt: fresh ? data.last_fix_at : null,
  };
}
