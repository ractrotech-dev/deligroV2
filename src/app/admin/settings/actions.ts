"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { updateSettings } from "@/lib/data-access/settings";
import { getSettingsSnapshot } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";
import {
  CommissionNotMigratedError,
  clampCommissionPct,
  setCommissionGstPct,
  setVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import { safeApkUrl, type ReleaseApp } from "@/lib/releases/app-version";
import { ALERT_PRESETS, type AlertPreset } from "@/lib/alerts/tones";
import type { PlatformSettings } from "@/types";

const PRESET_IDS = ALERT_PRESETS.map((p) => p.id);

/** An unrecognised value (or none submitted) keeps whatever is already stored. */
function preset(raw: FormDataEntryValue | null, fallback: string): AlertPreset {
  const s = typeof raw === "string" ? raw : "";
  return (PRESET_IDS as string[]).includes(s) ? (s as AlertPreset) : (fallback as AlertPreset);
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function num(raw: FormDataEntryValue | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function int(raw: FormDataEntryValue | null, fallback: number): number {
  return Math.max(0, Math.trunc(num(raw, fallback)));
}

function str(raw: FormDataEntryValue | null): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** A checkbox is present in the FormData only when checked. */
function bool(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

/**
 * One app's release track, read off the form.
 *
 * The minimum is clamped to the latest rather than rejected. A minimum above
 * the latest is the one setting on this page with no way back: it force-updates
 * every installed app to a build that does not exist, and the APK URL it hands
 * them is the release they are already on. The 0045 CHECK constraint would
 * refuse the row, but that throws away the rest of a saved form over a typo in
 * a spinner — and on a pre-0045 database there is no constraint at all.
 *
 * Floored at 1 to match the same constraint, and to keep the fallback identity
 * that `app-version.ts` relies on: every real build is >= 1.
 */
function releaseTrack(
  form: FormData,
  app: ReleaseApp,
  current: { latest: number; min: number }
): { latest: number; min: number; url: string; notes: string } {
  const latest = Math.max(1, int(form.get(`${app}ApkVersionCode`), current.latest));
  const min = Math.max(1, int(form.get(`${app}ApkMinVersionCode`), current.min));
  return {
    latest,
    min: Math.min(min, latest),
    // https only, and dropped rather than rejected — see `safeApkUrl`. An
    // operator who pastes an http link gets an empty field back on the next
    // render, which is the visible signal; storing it would put a MITM-able
    // install URL in front of a fleet.
    url: safeApkUrl(str(form.get(`${app}ApkUrl`))),
    notes: str(form.get(`${app}ApkNotes`)),
  };
}

/**
 * Read the settings form into the domain shape. Percentages → fractions.
 *
 * `current` is what is stored right now, for fields the form no longer renders.
 */
function parse(form: FormData, current: PlatformSettings): PlatformSettings {
  const taxPct = num(form.get("taxRatePct"), 5);
  const commissionPct = num(form.get("riderCommissionPct"), 8);
  const rider = releaseTrack(form, "rider", {
    latest: current.riderApkVersionCode,
    min: current.riderApkMinVersionCode,
  });
  const customer = releaseTrack(form, "customer", {
    latest: current.customerApkVersionCode,
    min: current.customerApkMinVersionCode,
  });
  const vendor = releaseTrack(form, "vendor", {
    latest: current.vendorApkVersionCode,
    min: current.vendorApkMinVersionCode,
  });
  const manager = releaseTrack(form, "manager", {
    latest: current.managerApkVersionCode,
    min: current.managerApkMinVersionCode,
  });
  return {
    deliveryFee: int(form.get("deliveryFee"), 29),
    // Stored as a fraction; the admin edits whole percent. Clamp 0–100%.
    taxRate: Math.min(1, Math.max(0, taxPct / 100)),
    freeDeliveryThreshold: int(form.get("freeDeliveryThreshold"), 0),
    minOrder: int(form.get("minOrder"), 0),

    businessName: str(form.get("businessName")) || "Deligro",
    supportPhone: str(form.get("supportPhone")),
    supportEmail: str(form.get("supportEmail")),
    supportWhatsapp: str(form.get("supportWhatsapp")),
    businessAddress: str(form.get("businessAddress")),

    acceptingOrders: bool(form, "acceptingOrders"),
    maintenanceMessage: str(form.get("maintenanceMessage")),
    featureGrocery: bool(form, "featureGrocery"),
    // Carried through from what is stored, not read from the form: the pharmacy
    // switch was removed because the vertical does not exist (see
    // settings-form.tsx), and `bool()` on an absent checkbox returns false — so
    // reading it would silently rewrite the column to false on every save.
    // Untouched until something actually consumes it.
    featurePharmacy: current.featurePharmacy,
    featurePickDrop: bool(form, "featurePickDrop"),
    featureOnlinePayment: bool(form, "featureOnlinePayment"),

    defaultPrepMinutes: int(form.get("defaultPrepMinutes"), 20),
    deliveryRadiusKm: Math.max(0, num(form.get("deliveryRadiusKm"), 8)),
    riderCommission: Math.min(1, Math.max(0, commissionPct / 100)),
    riderMinPayout: int(form.get("riderMinPayout"), 30),

    // Clamped to the same bounds as the 0033 CHECK constraints. A value outside
    // them would be rejected by the database anyway; clamping here turns that
    // into a saved form rather than a thrown error on an unrelated field.
    reviewWindowDays: Math.min(
      365,
      Math.max(1, int(form.get("reviewWindowDays"), DEFAULT_SETTINGS.reviewWindowDays))
    ),
    reviewEditWindowHours: Math.min(
      720,
      Math.max(
        0,
        int(
          form.get("reviewEditWindowHours"),
          DEFAULT_SETTINGS.reviewEditWindowHours
        )
      )
    ),

    riderApkVersionCode: rider.latest,
    riderApkMinVersionCode: rider.min,
    riderApkUrl: rider.url,
    riderApkNotes: rider.notes,
    customerApkVersionCode: customer.latest,
    customerApkMinVersionCode: customer.min,
    customerApkUrl: customer.url,
    customerApkNotes: customer.notes,
    vendorApkVersionCode: vendor.latest,
    vendorApkMinVersionCode: vendor.min,
    vendorApkUrl: vendor.url,
    vendorApkNotes: vendor.notes,
    managerApkVersionCode: manager.latest,
    managerApkMinVersionCode: manager.min,
    managerApkUrl: manager.url,
    managerApkNotes: manager.notes,
    vendorAlertSoundPreset: preset(
      form.get("vendorAlertSoundPreset"),
      current.vendorAlertSoundPreset
    ),
    // Written by the upload widget as hidden fields (mirrors the vendor-logo
    // upload flow): rendered only while a custom sound is set, so a field's
    // ABSENCE is how "Remove custom sound" clears it back to null — not an
    // empty string, which `str()` would collapse the same way anyway.
    vendorAlertSoundUrl: form.has("vendorAlertSoundUrl")
      ? str(form.get("vendorAlertSoundUrl")) || null
      : current.vendorAlertSoundUrl,
    vendorAlertSoundName: form.has("vendorAlertSoundName")
      ? str(form.get("vendorAlertSoundName")) || null
      : current.vendorAlertSoundName,
    riderAlertSoundPreset: preset(
      form.get("riderAlertSoundPreset"),
      current.riderAlertSoundPreset
    ),
    riderAlertSoundUrl: form.has("riderAlertSoundUrl")
      ? str(form.get("riderAlertSoundUrl")) || null
      : current.riderAlertSoundUrl,
    riderAlertSoundName: form.has("riderAlertSoundName")
      ? str(form.get("riderAlertSoundName")) || null
      : current.riderAlertSoundName,

    // https only, dropped rather than rejected — the same rule as the APK
    // links above. The apps open these from a sign-in screen, before anyone is
    // authenticated.
    privacyPolicyUrl: legalLink(form.get("privacyPolicyUrl")),
    termsUrl: legalLink(form.get("termsUrl")),
  };
}

/**
 * A privacy or terms link: `safeApkUrl`, plus the literal `https://` prefix the
 * 0081 CHECK constraints test for. `https:example.com` parses as an https URL,
 * so without the second test it would pass here, be refused by the database,
 * and take the whole settings save down with it.
 */
function legalLink(raw: FormDataEntryValue | null): string {
  const url = safeApkUrl(str(raw));
  return /^https:\/\//i.test(url) ? url : "";
}

export async function saveSettingsAction(
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  await requireRole("admin");
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      error:
        "Demo mode: connect Supabase and apply migration 0015 to persist settings.",
    };
  }

  // Clamped here as well as in the data layer and by a CHECK constraint: this
  // is a public HTTP endpoint, so the number in the form is whatever the caller
  // chose to post, not whatever the number input allowed.
  const vendorCommissionPct = clampCommissionPct(
    num(form.get("vendorCommissionPct"), 0)
  );
  const commissionGstPct = clampCommissionPct(
    num(form.get("commissionGstPct"), 0)
  );

  // Read before write, for the fields this form no longer renders. If the
  // settings row is currently unreadable this bails out rather than saving:
  // `getSettings()` answers with fallback defaults during an outage (see
  // lib/settings.ts), and writing those over a live configuration would turn a
  // transient read failure into permanent data loss.
  const snapshot = await getSettingsSnapshot();
  if (snapshot.source === "unavailable") {
    return {
      ok: false,
      error:
        "Settings can't be read right now, so saving would overwrite your configuration with defaults. Reload and try again.",
    };
  }

  try {
    await updateSettings(parse(form, snapshot.settings));
  } catch {
    return { ok: false, error: "Couldn't save settings. Try again." };
  }

  // Separate write: the column is admin-only and goes through the service-role
  // client, so it cannot ride along with the RLS-scoped settings update. Kept
  // after it deliberately — if this throws, the rest of the form is already
  // saved and the admin is told which part did not land.
  try {
    await setVendorCommissionDefault(vendorCommissionPct);
    // Same column family, same client, same failure mode — and it deducts from
    // every vendor payout, so it is saved with the rate rather than in a
    // separate pass that could land while the rate did not.
    await setCommissionGstPct(commissionGstPct);
  } catch (e) {
    if (e instanceof CommissionNotMigratedError) {
      return {
        ok: false,
        error:
          "Saved everything except the vendor commission and its GST — apply migrations 0032_platform_commission.sql and 0034_vendor_payments_and_payouts.sql to store them.",
      };
    }
    return {
      ok: false,
      error: "Saved the rest, but couldn't save the vendor commission.",
    };
  }

  // Fees, availability and support text are read across the app — rebuild it.
  revalidatePath("/", "layout");
  revalidatePath("/admin/settings/platform");
  // Settlement previews quote the rate; drop their cached copies too.
  revalidatePath("/admin/settlements", "layout");
  return { ok: true };
}
