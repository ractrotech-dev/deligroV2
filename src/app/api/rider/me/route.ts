import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { createClient } from "@/lib/supabase/server";
import { getFeatures } from "@/lib/features/flags.server";
import {
  getActiveDeliveryId,
  getRiderAvailability,
  getRiderCode,
  getRiderLegalLinks,
} from "@/lib/data-access/rider-status";
import { getRiderProfileStatus } from "@/lib/data-access/rider-profile";
import { riderPhase } from "@/lib/rider/availability";
import type { FeatureKey } from "@/lib/features/catalog";

/** The switches the rider app reads. */
const RIDER_FEATURES = [
  "driver.history",
  "driver.earnings",
  "driver.call_customer",
  "driver.navigation",
  "driver.profile_edit",
] as const satisfies readonly FeatureKey[];

/**
 * GET /api/rider/me — who the signed-in rider is and where they stand.
 *
 * The app calls it on launch and on resume, and it is the one place the app
 * learns its phase, its rider ID, which tabs are switched on and which legal
 * links exist. Read-only, so no rate-limit rule applies. It answers 200 on a
 * database without migration 0081: offline, `riderCode: null`.
 *
 * `profile` (0086): `{ verification, documentsComplete, needsAttention }` for
 * the Home badge and the red dot on More -> Profile & documents; null on a
 * database without 0086.
 */
export async function GET() {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  try {
    // The avatar is the rider's own profile row, read under their session (RLS),
    // not through the service-role client.
    const supabase = await createClient();
    const [availability, riderCode, activeDeliveryId, features, legal, avatar, profileStatus] =
      await Promise.all([
        getRiderAvailability(profile.id),
        getRiderCode(profile.id),
        getActiveDeliveryId(profile.id),
        getFeatures("driver", profile.id),
        getRiderLegalLinks(),
        supabase.from("profiles").select("avatar_url").eq("id", profile.id).maybeSingle(),
        getRiderProfileStatus(profile.id),
      ]);

    return NextResponse.json({
      id: profile.id,
      name: profile.full_name?.trim() ?? "",
      phone: profile.phone,
      avatarUrl: (avatar.data?.avatar_url as string | null | undefined) ?? null,
      riderCode,
      availability,
      phase: riderPhase(availability, new Date()),
      activeDeliveryId,
      features: Object.fromEntries(RIDER_FEATURES.map((k) => [k, features[k] !== false])),
      legal,
      profile: profileStatus,
    });
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/me", method: "GET", riderId: profile.id });
  }
}
