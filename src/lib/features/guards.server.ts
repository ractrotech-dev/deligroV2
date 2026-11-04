import "server-only";
import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { resolveVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { FEATURE_OFF_MESSAGE, allOn, featuresFor, pickRole, type FeatureKey } from "@/lib/features/catalog";
import { FeatureDisabledError, getFeatures, isFeatureOn } from "@/lib/features/flags.server";

/**
 * The server half of every feature switch — call AFTER the role check.
 *
 * An admin is never switched off in the vendor, manager or rider portals: an
 * admin acting through those is support, not the subject of the restriction.
 * The admin console's own screens have their own switches (`adminFeatureOn`).
 */

/**
 * Customer features are set per person. A guest has no person, so they follow the
 * "for everyone" value. Works for anyone in the customer app: an admin is never
 * switched off, and a failed profile read is a guest, not an error.
 */
export async function customerFeatureOn(key: FeatureKey): Promise<boolean> {
  return (await customerFeatures())[key] === true;
}

/** Every customer switch for whoever is asking: what `/api/me` and the website send. */
export async function customerFeatures(): Promise<Record<string, boolean>> {
  const profile = await getProfile().catch(() => null);
  if (profile?.role === "admin") return pickRole("customer", allOn());
  return pickRole("customer", await getFeatures("customer", profile?.id ?? null));
}

/** Vendor features are set per shop: the shop this vendor is working in. */
export async function vendorFeatureOn(key: FeatureKey): Promise<boolean> {
  const profile = await getProfile();
  if (profile?.role === "admin") return true;
  const shop = await resolveVendorRestaurant().catch(() => null);
  return isFeatureOn(key, shop?.id ?? null);
}

/** Manager and rider features are set per person. */
export async function staffFeatureOn(key: FeatureKey): Promise<boolean> {
  const profile = await getProfile();
  if (!profile || profile.role === "admin") return true;
  return isFeatureOn(key, profile.id);
}

/**
 * Admin-console screens (`admin.*`) are switched for every admin at once, so
 * this reads the role-wide switch only. Call AFTER `requireRole("admin")`.
 * A failed read falls back to the default (on): these are product switches,
 * not the security boundary, and a blip must not hide a console screen.
 */
export async function adminFeatureOn(key: FeatureKey): Promise<boolean> {
  return isFeatureOn(key, null);
}

/** Every admin-console screen switched off — what the admin chrome hides. */
export async function adminFeaturesOff(): Promise<FeatureKey[]> {
  const map = await getFeatures("admin", null);
  return featuresFor("admin")
    .map((f) => f.key as FeatureKey)
    .filter((k) => !map[k]);
}

export async function assertVendorFeature(key: FeatureKey): Promise<void> {
  if (!(await vendorFeatureOn(key))) throw new FeatureDisabledError(key);
}

/**
 * Profile edits go through routes every signed-in user shares (/api/profile,
 * /api/profile/avatar). Only a RIDER with "Edit profile" switched off is
 * refused; customers, vendors and managers are never affected.
 */
export async function riderProfileEditBlocked(): Promise<boolean> {
  const profile = await getProfile();
  if (profile?.role !== "driver") return false;
  return !(await isFeatureOn("driver.profile_edit", profile.id));
}

/**
 * Profile edits go through routes every signed-in user shares. The customer switch
 * for everyone who isn't staff. Rider rules are `riderProfileEditBlocked`; vendors
 * and managers have no switch here.
 */
export async function customerProfileEditBlocked(): Promise<boolean> {
  const profile = await getProfile();
  if (profile?.role !== "customer") return false;
  return !(await isFeatureOn("customer.profile_edit", profile.id));
}

/** For route handlers: the 403 a switched-off feature answers with. */
export function featureOffResponse(key: FeatureKey) {
  return NextResponse.json(
    { ok: false, error: "feature_disabled", feature: key, message: FEATURE_OFF_MESSAGE },
    { status: 403 }
  );
}
