import { profileJson, profileRouteError, readJson, riderProfileGate } from "@/lib/auth/rider-profile-route";
import { getRiderProfile, updateRiderProfileDirect } from "@/lib/data-access/rider-profile";
import { parseProfilePatch } from "@/lib/rider/profile-rules";

const ROUTE = "/api/rider/profile";

/**
 * GET /api/rider/profile — the rider's profile, documents and pending changes
 * (Profile & documents in the app). Payout account and document numbers come
 * back masked; the rider's own licence number in full.
 *
 *   200 { profile: RiderProfile }
 *   401 · 403 not_rider · 429 · 503 migration_pending (no 0086) · 500
 */
export async function GET() {
  const gate = await riderProfileGate(ROUTE, { write: false, perMinute: 30 });
  if (!gate.ok) return gate.response;
  try {
    return profileJson({ profile: await getRiderProfile(gate.driverId) });
  } catch (e) {
    return profileRouteError(e, ROUTE, "GET", gate.driverId);
  }
}

/**
 * PATCH /api/rider/profile — the fields that save directly.
 *
 *   body { address?: { line?, city?, pincode? }, emergency?: { name?, phone?, relation? }, vehicleType? }
 *        (a sub-field left out keeps its value; "" or null clears it; any other key is refused)
 *
 *   200 { ok: true, profile }
 *   400 invalid_body | invalid_value (+ field, e.g. "address.pincode")
 *   409 needs_approval (+ field "vehicleType")   the rider is verified: send a vehicle change request
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 *
 * Name, licence, vehicle and payout account go through
 * POST /api/rider/profile/change-requests.
 */
export async function PATCH(request: Request) {
  const gate = await riderProfileGate(ROUTE, { write: true, perMinute: 30 });
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  if (body === null) return profileJson({ error: "invalid_body" }, 400);
  const parsed = parseProfilePatch(body);
  if (!parsed.ok) return profileJson({ error: parsed.error, field: parsed.field }, 400);

  try {
    const result = await updateRiderProfileDirect(gate.driverId, parsed.value);
    if (!result.ok) return profileJson({ error: result.error, field: result.field }, 409);
    return profileJson({ ok: true, profile: await getRiderProfile(gate.driverId) });
  } catch (e) {
    return profileRouteError(e, ROUTE, "PATCH", gate.driverId);
  }
}
