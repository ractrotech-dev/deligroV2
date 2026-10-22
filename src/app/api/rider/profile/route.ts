import { profileEditBlocked, profileJson, profileRouteError, readJson, riderProfileGate } from "@/lib/auth/rider-profile-route";
import {
  NotificationPrefsConflictError,
  getRiderProfile,
  updateNotificationPrefs,
  updateRiderProfileDirect,
} from "@/lib/data-access/rider-profile";
import { isNotificationPrefsOnly, parseProfilePatch } from "@/lib/rider/profile-rules";

const ROUTE = "/api/rider/profile";

/**
 * GET /api/rider/profile — the rider's profile, documents and pending changes
 * (Profile & documents in the app). Payout account and document numbers come
 * back masked; the rider's own licence number in full.
 *
 *   200 { profile: RiderProfile }
 *        profile.notificationPrefs: { <category>: boolean } for every category; offers, cancellations
 *        and safety are always true. All true when the column is missing.
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
 * PATCH /api/rider/profile - the fields that save directly.
 *
 *   body { address?: { line?, city?, pincode? }, emergency?: { name?, phone?, relation? }, vehicleType? }
 *        (a sub-field left out keeps its value; "" or null clears it; any other key is refused)
 *   and/or { notificationPrefs: { <category>: boolean } } - merged into the stored switches: only
 *        the categories sent change; false switches one off, true switches it back on. Saves
 *        directly (no approval, whatever the verification state). `{}` writes nothing.
 *
 *   200 { ok: true, profile }          (profile.notificationPrefs = the updated effective switches)
 *   400 invalid_body | invalid_value (+ field, e.g. "address.pincode", "notificationPrefs.<key>")
 *   400 locked_category (+ field)       offers, cancellations and safety cannot be switched off
 *   409 needs_approval (+ field "vehicleType")   the rider is verified: send a vehicle change request
 *   409 conflict                        the switches changed at the same time, five times over: try again
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 *
 * Gate (ruling P7-R5): rider auth and the 30/min rate limit always. The
 * `driver.profile_edit` switch applies to the profile fields only: a body that
 * carries nothing but `notificationPrefs` is not an edit of the profile and
 * goes through with the switch off; a body that carries other fields with it
 * needs the switch for those.
 *
 * A combined body applies address / emergency / vehicle first, then the
 * switches. Each part is idempotent, so a retry after a failure part-way (or
 * after a 409) is safe: it writes the same values again.
 *
 * Switches are written read-merge-write with a compare-and-swap on the jsonb
 * value (PostgREST has no one-statement jsonb merge without a SQL function).
 * That `eq` on a jsonb column needs one real request on staging; the SQL it
 * generates is proved in scripts/qa/sql/migration-0086.mjs, the rest against
 * a fake PostgREST.
 *
 * Name, licence, vehicle and payout account go through
 * POST /api/rider/profile/change-requests.
 */
export async function PATCH(request: Request) {
  const gate = await riderProfileGate(ROUTE, { write: false, perMinute: 30 });
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  const prefsOnly = isNotificationPrefsOnly(body);
  if (!prefsOnly) {
    const blocked = await profileEditBlocked(gate.driverId);
    if (blocked) return blocked;
  }

  if (body === null) return profileJson({ error: "invalid_body" }, 400);
  const parsed = parseProfilePatch(body);
  if (!parsed.ok) return profileJson({ error: parsed.error, field: parsed.field }, 400);

  try {
    const { notificationPrefs, ...fields } = parsed.value;
    if (Object.keys(fields).length > 0) {
      const result = await updateRiderProfileDirect(gate.driverId, fields);
      if (!result.ok) return profileJson({ error: result.error, field: result.field }, 409);
    }
    if (notificationPrefs && Object.keys(notificationPrefs).length > 0) {
      await updateNotificationPrefs(gate.driverId, notificationPrefs);
    }
    return profileJson({ ok: true, profile: await getRiderProfile(gate.driverId) });
  } catch (e) {
    if (e instanceof NotificationPrefsConflictError) {
      return profileJson({ error: "conflict", message: "Your notification settings changed at the same time. Please try again." }, 409);
    }
    return profileRouteError(e, ROUTE, "PATCH", gate.driverId);
  }
}
