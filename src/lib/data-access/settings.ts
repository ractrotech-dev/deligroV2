import "server-only";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_SETTINGS, POD_PHOTO_RULES } from "@/lib/settings-defaults";
import {
  columnKnownMissing,
  columnKnownPresent,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { PlatformSettings, PodPhotoRule } from "@/types";

/**
 * The single platform-settings row, from Supabase. Reads ride the public-read
 * policy; the update rides the admin-write policy (a non-admin write is rejected
 * by RLS, so it throws — a silently-dropped settings save is worse than a loud
 * one). Missing table (migration 0015 not applied) is signalled distinctly so
 * the facade can fall back to defaults during rollout.
 */

export class SettingsNotMigratedError extends Error {
  constructor() {
    super("settings_not_migrated");
    this.name = "SettingsNotMigratedError";
  }
}

/**
 * The table is there and we still could not read it — an RLS or grant
 * regression, an unreachable database, a column the probes did not catch.
 *
 * Distinct from `SettingsNotMigratedError` because the two mean opposite
 * things. "Not migrated" is a known state with a known answer: nothing is
 * configured, so the defaults ARE the configuration. This one means we do not
 * know what the admin configured, and the caller must not pretend otherwise.
 */
export class SettingsUnavailableError extends Error {
  constructor(readonly cause?: unknown) {
    super("settings_unavailable");
    this.name = "SettingsUnavailableError";
  }
}

function isMissingTable(
  error: { code?: string; message?: string } | null
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("schema cache") ||
    msg.includes("does not exist")
  );
}

interface SettingsRow {
  delivery_fee: number;
  tax_rate: number | string;
  free_delivery_threshold: number;
  min_order: number;
  business_name: string;
  support_phone: string;
  support_email: string;
  support_whatsapp: string;
  business_address: string;
  accepting_orders: boolean;
  maintenance_message: string;
  feature_grocery: boolean;
  feature_pharmacy: boolean;
  feature_pick_drop: boolean;
  default_prep_minutes: number;
  delivery_radius_km: number | string;
  feature_online_payment?: boolean;
  review_window_days?: number;
  review_edit_window_hours?: number;
  rider_apk_version_code?: number;
  rider_apk_min_version_code?: number;
  rider_apk_url?: string;
  rider_apk_notes?: string;
  customer_apk_version_code?: number;
  customer_apk_min_version_code?: number;
  customer_apk_url?: string;
  customer_apk_notes?: string;
  vendor_alert_sound_preset?: string;
  vendor_alert_sound_url?: string | null;
  vendor_alert_sound_name?: string | null;
  rider_alert_sound_preset?: string;
  rider_alert_sound_url?: string | null;
  rider_alert_sound_name?: string | null;
  privacy_policy_url?: string;
  terms_url?: string;
  rider_offer_window_seconds?: number;
  pod_photo_rule?: string;
  unreachable_wait_minutes?: number;
  high_demand_ratio?: number | string;
  pickup_reminder_minutes?: number;
  delay_alert_minutes?: number;
  routing_base_url?: string;
  rider_base_fee?: number | string;
  rider_km_included?: number | string;
  rider_per_km?: number | string;
  rider_min_per_delivery?: number | string;
  rider_cash_limit?: number;
  rider_cash_max_hours?: number;
  rider_daily_target?: number;
  rider_weekly_target?: number;
  block_dispatch_on_expired_docs?: boolean;
}

/**
 * Columns that postdate `platform_settings` itself. Each group sits behind its
 * own probe key, so one un-applied migration costs that group and nothing else.
 *
 * Grouped rather than listed per-column because the columns in a group arrive in
 * the same migration — if one is there they all are, so one probe answers for
 * the set.
 */
const OPTIONAL_GROUPS = [
  {
    /** Migration 0025. */
    key: "platform_settings.feature_online_payment",
    select: "feature_online_payment",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      feature_online_payment: input.featureOnlinePayment,
    }),
  },
  {
    /** Migration 0033. */
    key: "platform_settings.review_window_days",
    select: "review_window_days, review_edit_window_hours",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      review_window_days: input.reviewWindowDays,
      review_edit_window_hours: input.reviewEditWindowHours,
    }),
  },
  {
    /**
     * Migration 0045. All eight columns arrive together, so the one probe key
     * answers for the set — the same reasoning as the 0033 pair above.
     */
    key: "platform_settings.rider_apk_version_code",
    select:
      "rider_apk_version_code, rider_apk_min_version_code, rider_apk_url, rider_apk_notes, " +
      "customer_apk_version_code, customer_apk_min_version_code, customer_apk_url, customer_apk_notes",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      rider_apk_version_code: input.riderApkVersionCode,
      rider_apk_min_version_code: input.riderApkMinVersionCode,
      rider_apk_url: input.riderApkUrl,
      rider_apk_notes: input.riderApkNotes,
      customer_apk_version_code: input.customerApkVersionCode,
      customer_apk_min_version_code: input.customerApkMinVersionCode,
      customer_apk_url: input.customerApkUrl,
      customer_apk_notes: input.customerApkNotes,
    }),
  },
  {
    /** Migration 0044. */
    key: "platform_settings.vendor_alert_sound_preset",
    select:
      "vendor_alert_sound_preset, vendor_alert_sound_url, vendor_alert_sound_name, rider_alert_sound_preset, rider_alert_sound_url, rider_alert_sound_name",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      vendor_alert_sound_preset: input.vendorAlertSoundPreset,
      vendor_alert_sound_url: input.vendorAlertSoundUrl,
      vendor_alert_sound_name: input.vendorAlertSoundName,
      rider_alert_sound_preset: input.riderAlertSoundPreset,
      rider_alert_sound_url: input.riderAlertSoundUrl,
      rider_alert_sound_name: input.riderAlertSoundName,
    }),
  },
  {
    /** Migration 0081. The pair arrives together. */
    key: "platform_settings.privacy_policy_url",
    select: "privacy_policy_url, terms_url",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      privacy_policy_url: input.privacyPolicyUrl,
      terms_url: input.termsUrl,
    }),
  },
  {
    /** Migration 0082. The four rider-jobs settings arrive together. */
    key: "platform_settings.rider_offer_window_seconds",
    select:
      "rider_offer_window_seconds, pod_photo_rule, unreachable_wait_minutes, routing_base_url",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      rider_offer_window_seconds: input.riderOfferWindowSeconds,
      pod_photo_rule: input.podPhotoRule,
      unreachable_wait_minutes: input.unreachableWaitMinutes,
      routing_base_url: input.routingBaseUrl,
    }),
  },
  {
    /** Migration 0087. The three rider alert thresholds arrive together. */
    key: "platform_settings.high_demand_ratio",
    select: "high_demand_ratio, pickup_reminder_minutes, delay_alert_minutes",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      high_demand_ratio: input.highDemandRatio,
      pickup_reminder_minutes: input.pickupReminderMinutes,
      delay_alert_minutes: input.delayAlertMinutes,
    }),
  },
  {
    /**
     * Migration 0083. The dormant rider rate card arrives as four columns
     * together. A database without them reads ₹0 for all four
     * (DEFAULT_SETTINGS), which is also the 0083 default.
     *
     * Read only (P3-R11): riders are salaried, so no screen edits the rate card
     * and a save never writes it. The group stays so the columns stay mapped
     * and can be set in the database if the owner ever changes the model.
     */
    key: "platform_settings.rider_base_fee",
    select: "rider_base_fee, rider_km_included, rider_per_km, rider_min_per_delivery",
    write: (): Record<string, unknown> => ({}),
  },
  {
    /** Migration 0085. The two rider cash thresholds arrive together. */
    key: "platform_settings.rider_cash_limit",
    select: "rider_cash_limit, rider_cash_max_hours",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      rider_cash_limit: input.riderCashLimit,
      rider_cash_max_hours: input.riderCashMaxHours,
    }),
  },
  {
    /** Migration 0084. The two default delivery targets arrive together. */
    key: "platform_settings.rider_daily_target",
    select: "rider_daily_target, rider_weekly_target",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      rider_daily_target: input.riderDailyTarget,
      rider_weekly_target: input.riderWeeklyTarget,
    }),
  },
  {
    /** Migration 0086. Read by dispatch with the service role as well. */
    key: "platform_settings.block_dispatch_on_expired_docs",
    select: "block_dispatch_on_expired_docs",
    write: (input: PlatformSettings): Record<string, unknown> => ({
      block_dispatch_on_expired_docs: input.blockDispatchOnExpiredDocs,
    }),
  },
] as const;

type OptionalGroup = (typeof OPTIONAL_GROUPS)[number];

const BASE_SELECT = `
  delivery_fee, tax_rate, free_delivery_threshold, min_order,
  business_name, support_phone, support_email, support_whatsapp, business_address,
  accepting_orders, maintenance_message,
  feature_grocery, feature_pharmacy, feature_pick_drop,
  default_prep_minutes, delivery_radius_km
`;

/**
 * Which optional groups this database actually has.
 *
 * Probed group by group rather than inferred from a failed combined read.
 * A single 42703 says "some column in this list is missing" but not which, so
 * dropping a group on that signal is a guess — and guessing wrong marks a
 * present column absent, which silently substitutes a default for a value the
 * admin configured. That is the exact failure the online-payment comment below
 * was written about, so it is not repeated here.
 *
 * The probes are independent (one key each, one HEAD request each), so they
 * run concurrently; the result keeps OPTIONAL_GROUPS order.
 *
 * The probes latch in `schema-probe`, so this costs one HEAD request per group
 * once per process, and nothing thereafter. A transient failure does not latch.
 */
async function availableGroups(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<OptionalGroup[]> {
  const probed = await Promise.all(
    OPTIONAL_GROUPS.map(async (group): Promise<OptionalGroup | null> => {
      if (columnKnownMissing(group.key)) return null;
      if (columnKnownPresent(group.key)) return group;

      const { error } = await supabase
        .from("platform_settings")
        .select(group.select, { head: true, count: "exact" })
        .limit(1);

      if (!error) {
        rememberColumn(group.key, true);
        return group;
      }
      if (isMissingColumn(error)) rememberColumn(group.key, false);
      // Anything else is transient: skip the group for this read without
      // latching, so the next request probes again instead of writing it off.
      return null;
    })
  );

  return probed.filter((group): group is OptionalGroup => group !== null);
}

function mapSettings(row: SettingsRow): PlatformSettings {
  return {
    deliveryFee: Number(row.delivery_fee),
    taxRate: Number(row.tax_rate),
    freeDeliveryThreshold: Number(row.free_delivery_threshold),
    minOrder: Number(row.min_order),
    businessName: row.business_name,
    supportPhone: row.support_phone,
    supportEmail: row.support_email,
    supportWhatsapp: row.support_whatsapp,
    businessAddress: row.business_address,
    acceptingOrders: row.accepting_orders,
    maintenanceMessage: row.maintenance_message,
    featureGrocery: row.feature_grocery,
    featurePharmacy: row.feature_pharmacy,
    featurePickDrop: row.feature_pick_drop,
    defaultPrepMinutes: Number(row.default_prep_minutes),
    deliveryRadiusKm: Number(row.delivery_radius_km),
    // Absent column (pre-0025) reads as off, which is the safe direction.
    featureOnlinePayment: row.feature_online_payment ?? false,
    // Absent columns (pre-0033) fall back to the shared defaults, so the review
    // windows behave identically before the migration lands.
    reviewWindowDays: Number(
      row.review_window_days ?? DEFAULT_SETTINGS.reviewWindowDays
    ),
    reviewEditWindowHours: Number(
      row.review_edit_window_hours ?? DEFAULT_SETTINGS.reviewEditWindowHours
    ),
    // Absent columns (pre-0045) fall back to the shared defaults, which pin
    // every version code to 1 — so a database without the migration reports
    // every app as current rather than as needing an update it has no URL for.
    riderApkVersionCode: Number(
      row.rider_apk_version_code ?? DEFAULT_SETTINGS.riderApkVersionCode
    ),
    riderApkMinVersionCode: Number(
      row.rider_apk_min_version_code ?? DEFAULT_SETTINGS.riderApkMinVersionCode
    ),
    riderApkUrl: row.rider_apk_url ?? DEFAULT_SETTINGS.riderApkUrl,
    riderApkNotes: row.rider_apk_notes ?? DEFAULT_SETTINGS.riderApkNotes,
    customerApkVersionCode: Number(
      row.customer_apk_version_code ?? DEFAULT_SETTINGS.customerApkVersionCode
    ),
    customerApkMinVersionCode: Number(
      row.customer_apk_min_version_code ??
        DEFAULT_SETTINGS.customerApkMinVersionCode
    ),
    customerApkUrl: row.customer_apk_url ?? DEFAULT_SETTINGS.customerApkUrl,
    customerApkNotes: row.customer_apk_notes ?? DEFAULT_SETTINGS.customerApkNotes,
    // Absent columns (pre-0044) fall back to the shared defaults — the
    // original hardcoded chime, unset custom sound — so nothing changes for
    // an install that hasn't run the migration yet.
    vendorAlertSoundPreset:
      row.vendor_alert_sound_preset ?? DEFAULT_SETTINGS.vendorAlertSoundPreset,
    vendorAlertSoundUrl: row.vendor_alert_sound_url ?? null,
    vendorAlertSoundName: row.vendor_alert_sound_name ?? null,
    riderAlertSoundPreset:
      row.rider_alert_sound_preset ?? DEFAULT_SETTINGS.riderAlertSoundPreset,
    riderAlertSoundUrl: row.rider_alert_sound_url ?? null,
    riderAlertSoundName: row.rider_alert_sound_name ?? null,
    // Absent columns (pre-0081) read as "nothing published", which is also
    // the truth on such a database: there was nowhere to store a link.
    privacyPolicyUrl: row.privacy_policy_url ?? DEFAULT_SETTINGS.privacyPolicyUrl,
    termsUrl: row.terms_url ?? DEFAULT_SETTINGS.termsUrl,
    // Absent columns (pre-0082) fall back to the shared defaults, which are
    // the behaviour before the settings existed: a 180 s offer window, no
    // proof photo, a 10-minute wait, the public OSRM server.
    riderOfferWindowSeconds: Number(
      row.rider_offer_window_seconds ?? DEFAULT_SETTINGS.riderOfferWindowSeconds
    ),
    podPhotoRule: parsePodPhotoRule(row.pod_photo_rule),
    unreachableWaitMinutes: Number(
      row.unreachable_wait_minutes ?? DEFAULT_SETTINGS.unreachableWaitMinutes
    ),
    routingBaseUrl: row.routing_base_url ?? DEFAULT_SETTINGS.routingBaseUrl,
    // Absent columns (pre-0087) read as the 0087 defaults.
    highDemandRatio: rateOf(row.high_demand_ratio, DEFAULT_SETTINGS.highDemandRatio) || DEFAULT_SETTINGS.highDemandRatio,
    pickupReminderMinutes: Number(row.pickup_reminder_minutes ?? DEFAULT_SETTINGS.pickupReminderMinutes),
    delayAlertMinutes: Number(row.delay_alert_minutes ?? DEFAULT_SETTINGS.delayAlertMinutes),
    // Absent columns (pre-0083) read as the ₹0 card, the 0083 default.
    riderRateCard: {
      baseFee: rateOf(row.rider_base_fee, DEFAULT_SETTINGS.riderRateCard.baseFee),
      kmIncluded: rateOf(row.rider_km_included, DEFAULT_SETTINGS.riderRateCard.kmIncluded),
      perKm: rateOf(row.rider_per_km, DEFAULT_SETTINGS.riderRateCard.perKm),
      minPerDelivery: rateOf(
        row.rider_min_per_delivery,
        DEFAULT_SETTINGS.riderRateCard.minPerDelivery
      ),
    },
    // Absent columns (pre-0085) read as the 0085 defaults.
    riderCashLimit: Number(row.rider_cash_limit ?? DEFAULT_SETTINGS.riderCashLimit),
    riderCashMaxHours: Number(row.rider_cash_max_hours ?? DEFAULT_SETTINGS.riderCashMaxHours),
    // Absent columns (pre-0084) read as "no default target".
    riderDailyTarget: targetOf(row.rider_daily_target, DEFAULT_SETTINGS.riderDailyTarget),
    riderWeeklyTarget: targetOf(row.rider_weekly_target, DEFAULT_SETTINGS.riderWeeklyTarget),
    // Absent column (pre-0086) reads as off, the 0086 default.
    blockDispatchOnExpiredDocs: row.block_dispatch_on_expired_docs === true,
  };
}

/** A delivery-count target: a whole number, never negative; absent or junk -> the default. */
function targetOf(raw: number | string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** A rate-card column (numeric, may arrive as a string); absent or junk -> the default. */
function rateOf(raw: number | string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A stored rule the type does not know (a later migration) reads as the default. */
function parsePodPhotoRule(raw: string | undefined): PodPhotoRule {
  return (POD_PHOTO_RULES as readonly string[]).includes(raw ?? "")
    ? (raw as PodPhotoRule)
    : DEFAULT_SETTINGS.podPhotoRule;
}

export async function getSettingsFromDb(): Promise<PlatformSettings> {
  const supabase = await createClient();
  const groups = await availableGroups(supabase);

  const columns = [BASE_SELECT, ...groups.map((g) => g.select)].join(", ");
  const result = await supabase
    .from("platform_settings")
    .select(columns)
    .eq("id", true)
    .maybeSingle();

  if (result.error) {
    // Checked BEFORE isMissingTable: PostgREST's missing-column message also
    // contains "does not exist", so the table check would swallow it and report
    // the wrong one of the two conditions. With the groups probed up front a
    // missing column here should be unreachable, so it is a real fault.
    if (isMissingColumn(result.error)) {
      throw new SettingsUnavailableError(result.error);
    }
    if (isMissingTable(result.error)) throw new SettingsNotMigratedError();
    // Every other failure used to `return DEFAULT_SETTINGS`, which is not a
    // fallback — it is an assertion, and a false one: "the fee is ₹29, the tax
    // is 5%, there is no minimum, and the platform is open for business". On a
    // database whose admin had paused ordering, that assertion un-paused it.
    // Throw; `lib/settings.ts` decides how to fail, and it fails closed.
    throw new SettingsUnavailableError(result.error);
  }
  // Table present, no row: migration 0015 seeds one, so this is a database
  // nobody has configured rather than one we cannot read. The defaults ARE the
  // configuration in that state, which is why this is not a fault.
  if (!result.data) return DEFAULT_SETTINGS;
  return mapSettings(result.data as unknown as SettingsRow);
}

export async function updateSettings(
  input: PlatformSettings
): Promise<void> {
  const supabase = await createClient();
  const base: Record<string, unknown> = {
      delivery_fee: input.deliveryFee,
      tax_rate: input.taxRate,
      free_delivery_threshold: input.freeDeliveryThreshold,
      min_order: input.minOrder,
      business_name: input.businessName,
      support_phone: input.supportPhone,
      support_email: input.supportEmail,
      support_whatsapp: input.supportWhatsapp,
      business_address: input.businessAddress,
      accepting_orders: input.acceptingOrders,
      maintenance_message: input.maintenanceMessage,
      feature_grocery: input.featureGrocery,
      feature_pharmacy: input.featurePharmacy,
      feature_pick_drop: input.featurePickDrop,
      default_prep_minutes: input.defaultPrepMinutes,
      delivery_radius_km: input.deliveryRadiusKm,
      updated_at: new Date().toISOString(),
  };

  // Same probe as the read: only write columns this database actually has, so a
  // pre-0025 or pre-0033 install saves everything else rather than failing the
  // whole form over a field whose only honest value there is the default.
  const groups = await availableGroups(supabase);
  const payload = groups.reduce<Record<string, unknown>>(
    (acc, group) => Object.assign(acc, group.write(input)),
    { ...base }
  );

  const { error } = await supabase
    .from("platform_settings")
    .update(payload)
    .eq("id", true);

  if (error) throw error;
}

/** Are the 0085 cash thresholds in this database? False only when positively found missing. */
export async function riderCashLimitsAvailable(): Promise<boolean> {
  const supabase = await createClient();
  await availableGroups(supabase);
  return !columnKnownMissing("platform_settings.rider_cash_limit");
}

/**
 * Are the 0084 default-target columns in this database? Same reading as
 * `riderCashLimitsAvailable`: false only on positive evidence.
 */
export async function riderTargetsAvailable(): Promise<boolean> {
  const supabase = await createClient();
  await availableGroups(supabase);
  return !columnKnownMissing("platform_settings.rider_daily_target");
}

/** Is the 0086 column in this database? False only when the probe found it missing. */
export async function riderDocsSettingAvailable(): Promise<boolean> {
  const supabase = await createClient();
  await availableGroups(supabase);
  return !columnKnownMissing("platform_settings.block_dispatch_on_expired_docs");
}

/** Does the settings table exist yet? Drives the Admin "run migration" notice. */
export async function settingsTableExists(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("platform_settings")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (error) return !isMissingTable(error);
  return true;
}
