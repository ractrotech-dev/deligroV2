import {
  DELIVERY_FEE,
  RIDER_COMMISSION,
  RIDER_MIN_PAYOUT,
  TAX_RATE,
} from "@/lib/pricing";
import type { PlatformSettings, PodPhotoRule } from "@/types";

/**
 * The platform config the app falls back to before any admin has saved settings
 * (and in demo mode / before migration 0015 runs). Money defaults are pulled
 * from `pricing.ts` so there is still exactly one canonical delivery-fee/tax
 * number — the Settings tab overrides it, it doesn't fork it.
 *
 * Pure and client-safe (no `server-only`), so both the billing code and the
 * client cart can share it.
 */
export const DEFAULT_SETTINGS: PlatformSettings = {
  deliveryFee: DELIVERY_FEE,
  taxRate: TAX_RATE,
  freeDeliveryThreshold: 0,
  minOrder: 0,

  businessName: "Deligro",
  supportPhone: "",
  supportEmail: "",
  supportWhatsapp: "",
  businessAddress: "",

  acceptingOrders: true,
  maintenanceMessage: "",
  featureGrocery: true,
  // Bemetara launch scope (28 Sept 2026): food, grocery and dairy only.
  // Medicines and Pick & Drop stay built but hidden until switched on.
  featurePharmacy: false,
  featurePickDrop: false,
  // Off until an admin turns it on. This default is also what an un-migrated or
  // unreadable settings row falls back to, which is the safe direction: the
  // failure mode is "COD only", never "offer a payment we cannot take".
  featureOnlinePayment: false,

  defaultPrepMinutes: 20,
  // One circle around Bemetara city centre — see lib/geo/service-area.ts.
  deliveryRadiusKm: 25,
  riderCommission: RIDER_COMMISSION,
  riderMinPayout: RIDER_MIN_PAYOUT,

  // Mirrors the 0033 column defaults, and the fallbacks baked into
  // `review_window_open()` / `review_edit_open()` — three places that must agree,
  // so changing one means changing all three.
  reviewWindowDays: 14,
  reviewEditWindowHours: 48,

  // Mirrors the 0045 column defaults exactly, and that agreement is what makes
  // `GET /api/app-version` safe with no fallback branch: any real installed
  // build has a versionCode >= 1, so against these values it is neither behind
  // the latest nor below the minimum, and the route answers "you are current".
  // An unreadable settings row therefore stops offering updates rather than
  // force-updating a fleet it cannot describe.
  riderApkVersionCode: 1,
  riderApkMinVersionCode: 1,
  riderApkUrl: "",
  riderApkNotes: "",
  customerApkVersionCode: 1,
  customerApkMinVersionCode: 1,
  customerApkUrl: "",
  customerApkNotes: "",
  vendorApkVersionCode: 1,
  vendorApkMinVersionCode: 1,
  vendorApkUrl: "",
  vendorApkNotes: "",
  managerApkVersionCode: 1,
  managerApkMinVersionCode: 1,
  managerApkUrl: "",
  managerApkNotes: "",
  vendorAlertSoundPreset: "chime",
  vendorAlertSoundUrl: null,
  vendorAlertSoundName: null,
  riderAlertSoundPreset: "chime",
  riderAlertSoundUrl: null,
  riderAlertSoundName: null,

  // Mirrors the 0081 column defaults: nothing published, nothing linked.
  privacyPolicyUrl: "",
  termsUrl: "",

  // Mirrors the 0082 column defaults. The offer window equals
  // EXCLUSIVE_OFFER_MS (180 s), so a database without the column dispatches
  // exactly as before; no photo is demanded that nothing could store.
  riderOfferWindowSeconds: 180,
  podPhotoRule: "never",
  unreachableWaitMinutes: 10,
  routingBaseUrl: "https://router.project-osrm.org",
};

/** Every `pod_photo_rule` value, in the order the admin form lists them (0082). */
export const POD_PHOTO_RULES: readonly PodPhotoRule[] = [
  "never",
  "cod",
  "always",
  "exceptions",
];
