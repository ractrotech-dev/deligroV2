import type { RateCard } from "@/lib/rider/earnings-math";

/** Domain types for the Deligro customer app (static / mock phase). */

export type Cuisine =
  | "North Indian"
  | "South Indian"
  | "Chinese"
  | "Italian"
  | "Fast Food"
  | "Healthy"
  | "Desserts"
  | "Biryani";

export type PriceTier = 1 | 2 | 3; // ₹ / ₹₹ / ₹₹₹

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  /** Sale price, in whole rupees — shown struck-through against `price` and charged instead of it, when set and actually lower. See `effectivePrice`. */
  discountPrice?: number | null;
  category: string;
  veg: boolean;
  image?: string;
  soldOut?: boolean;
  popular?: boolean;
  bestseller?: boolean;
  /** Units ordered in the popularity window — what the Popular rank is built on. */
  unitsSold?: number;
}

export interface Restaurant {
  slug: string;
  name: string;
  tagline: string;
  cuisines: Cuisine[];
  rating: number;
  ratingCount: number;
  /**
   * The band the shop is quoting right now, door to door — the vendor's
   * advertised numbers plus any live busy bump (migration 0036), resolved once
   * in `mapRestaurant`. Surfaces render it verbatim; none of them apply the
   * bump themselves, so none of them can forget to.
   */
  etaMin: number;
  etaMax: number;
  /** True while a busy bump is in force, so the band can be labelled not hidden. */
  busy?: boolean;
  /** Minutes the bump is adding. 0 when not busy. */
  busyExtraMinutes?: number;
  /** `restaurants.prep_minutes` — this kitchen's own leg. Null inherits the platform default. */
  prepMinutes?: number | null;
  priceTier: PriceTier;
  costForTwo: number;
  /**
   * Seeded, customer-independent distance — from the shop's own row, not
   * measured from anybody.
   *
   * Null when the row has none, which is the honest answer and is why this is
   * nullable: it used to default to 2, so every unseeded shop claimed to be
   * exactly 2 km from every customer. Nothing renders it — `ShopDistance`
   * measures from `lat`/`lng` and shows nothing without a pin — so treat this as
   * legacy seed data rather than a fallback to reach for. If you need a distance,
   * use `distanceToShop`, and render nothing when it returns null.
   */
  distanceKm: number | null;
  /** Where the shop actually is — null until the vendor pins it on the map. */
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  offer?: string;
  promoted?: boolean;
  open: boolean;
  categories: string[];
  menu: MenuItem[];
  /**
   * How this menu's Popular list was arrived at: "orders" = ranked by units sold
   * in the last 30 days, "picks" = too little order history to rank, so the
   * hand-picked flags stand in. The UI captions itself from this, so it never
   * calls a pick a bestseller.
   */
  popularBasis?: "orders" | "picks";
  accentTint: string; // photo fallback gradient (shows while the image loads)
  image: string; // cover photography
}

export interface Category {
  id: string;
  label: string;
  /** Fallback for the tile — shown while the photo loads, or if it fails. */
  emoji: string;
  /**
   * The tile photograph. A curated default from `lib/taxonomy.ts`, or the
   * operator's replacement from `category_images` (migration 0037) once one has
   * been set — resolved by `lib/categories.ts`, never by the component.
   */
  image: string;
  /** Gradient behind the photo, so the tile is never a grey hole. */
  tint: string;
}

/**
 * A storefront type on the Stores tab (bakery, dairy, …) — not a food cuisine.
 * `tags` are the vendor cuisine tags that belong to the category, so a store
 * shows up under it as soon as it carries one of them.
 *
 * Deliberately no longer `extends Category`. It shared a shape by coincidence,
 * and the coincidence ended when food categories gained photographs: a cuisine
 * has an obvious picture (a plate of biryani), a category of SHOP does not —
 * there is no honest single photo of "Pick & Drop". So `image` here is a
 * representative stock photo (bread for Bakery, a produce aisle for Groceries),
 * optional, with the emoji kept as the fallback when it is absent.
 */
export interface StoreCategory {
  id: string;
  label: string;
  emoji: string;
  /** Square tile photo. Optional — the tile falls back to `emoji`. */
  image?: string;
  tags: string[];
}

/**
 * The customer-facing order stages.
 *
 * These now map 1:1 onto the `order_status` enum instead of collapsing two of
 * its values into one. `ready` used to fold into `KITCHEN`, which meant nobody
 * — customer or admin — could tell "still cooking" from "packed, waiting for a
 * rider". That is precisely the window where an order goes wrong, and it was
 * the one window the system could not describe.
 *
 * PLACED means *awaiting* the kitchen's acceptance. It does not mean accepted.
 */
export type OrderStatus =
  | "PLACED"
  | "KITCHEN"
  | "READY"
  | "ON_THE_WAY"
  | "DELIVERED"
  | "CANCELLED";

interface OrderLine {
  itemId: string;
  name: string;
  qty: number;
  price: number;
  /** Undefined = unknown (the dish is no longer on the menu). Never assume veg. */
  veg?: boolean;
}

export interface Order {
  id: string;
  restaurantSlug: string;
  restaurantName: string;
  /** Populated from DB for order cards when mock getRestaurant() isn't available. */
  restaurantImage?: string;
  restaurantAccent?: string;
  status: OrderStatus;
  placedAt: string; // human label e.g. "Today, 8:24 PM"
  etaMinutes?: number;
  lines: OrderLine[];
  total: number;
  rider?: Rider;
}

export interface Rider {
  name: string;
  /**
   * The rider's Deligro ID, as printed on the card the customer is shown at
   * the door. Derived from the profile id (same `shortOrderId` shape used for
   * order codes), so it is stable, non-guessable in either direction, and
   * something a customer can quote to support about a specific courier.
   *
   * Optional because a mock order has no profile behind it, and because a real
   * one whose rider row could not be read should show a card without an ID
   * rather than no card at all.
   */
  id?: string;
  /** We don't rate riders yet. Undefined = unknown, never a flattering guess. */
  rating?: number;
  vehicle?: string;
  phone: string;
}

export interface Address {
  id: string;
  label: string;
  line: string;
  isDefault?: boolean;
}

export interface CartLine {
  itemId: string;
  name: string;
  price: number;
  qty: number;
  /** Undefined = unknown. A wrong veg mark is a dietary claim, so we show none. */
  veg?: boolean;
}

/* ============================================================
   Promotional banners / ad campaigns.

   The home screen (and other surfaces) never hardcode promos: they ask the
   backend for the active campaigns at a placement and render whatever comes
   back. Everything below is what the Admin Panel writes and the app reads.
   ============================================================ */

/**
 * Surfaces a banner can be pinned to. The app asks for one placement at a time;
 * a campaign can be attached to several. Adding a surface = adding a value here.
 */
export type BannerPlacement =
  | "home_hero" // the carousel under "Popular right now" on the food home
  | "home_food"
  | "stores_top" // top of the Stores tab
  | "grocery_top"
  | "pharmacy_top"
  | "checkout";

/**
 * Internal = a Deligro feature promo (Grocery, Pick & Drop, Membership…).
 * Sponsored = a paid campaign from a partner; it wears the "Sponsored" badge.
 */
export type BannerKind = "internal" | "sponsored";

/** Lifecycle. Only `active` (and in-window) campaigns are ever served. */
export type BannerStatus = "draft" | "active" | "paused" | "archived";

/**
 * Where the CTA takes the user. `value` is interpreted per type — a slug for
 * `restaurant`/`store`/`product`/`category`, a full URL for `external`, and is
 * ignored for the section shortcuts (they route to a fixed path).
 */
export type BannerTargetType =
  | "food"
  | "grocery"
  | "pick_drop"
  | "shops"
  | "pharmacy"
  | "membership"
  | "refer"
  | "restaurant"
  | "store"
  | "product"
  | "category"
  | "external";

interface BannerTarget {
  type: BannerTargetType;
  /** Slug / URL / category id, depending on `type`. */
  value?: string;
}

/** Optional audience narrowing. Empty arrays / undefined = everyone. */
interface BannerTargeting {
  cities?: string[];
  zones?: string[];
  categories?: string[];
  /** e.g. "new", "returning", "vip" — matched against the viewer's segment. */
  segments?: string[];
}

/** Rolled-up performance for the Admin list. */
interface BannerAnalytics {
  impressions: number;
  clicks: number;
  /** Click-through rate as a fraction (clicks / impressions), 0 when no views. */
  ctr: number;
  conversions: number;
  orders: number;
}

/* ============================================================
   Platform settings — the single admin-owned configuration row.

   These are values the app genuinely reads: order billing, the customer's
   support contacts, which delivery verticals are switched on, and the rider
   payout formula. The Admin Settings tab writes this; the app reads it.
   ============================================================ */
export interface PlatformSettings {
  // ---- Fees & tax (authoritative for billing) ----
  /** Flat delivery fee in whole rupees. */
  deliveryFee: number;
  /** Fraction applied to the item subtotal only (0.05 = 5%). */
  taxRate: number;
  /** Subtotal at/above which delivery is free. 0 = never free. */
  freeDeliveryThreshold: number;
  /** Minimum subtotal required to check out. 0 = no minimum. */
  minOrder: number;

  // ---- Support & brand ----
  businessName: string;
  supportPhone: string;
  supportEmail: string;
  supportWhatsapp: string;
  businessAddress: string;

  // ---- Availability ----
  /** Master switch — when off, the app stops taking new orders. */
  acceptingOrders: boolean;
  /** Shown to customers when set; empty = nothing shown. */
  maintenanceMessage: string;
  featureGrocery: boolean;
  featurePharmacy: boolean;
  featurePickDrop: boolean;
  /**
   * Offer online payment (Razorpay) at checkout. Off by default — the customer
   * sees "Available soon" and COD is the only method. Turning it on is
   * necessary but not sufficient: the app also requires the Razorpay keys, so a
   * keyless environment keeps showing "Available soon" rather than a checkout
   * that dead-ends. See `onlinePaymentsEnabled()`.
   */
  featureOnlinePayment: boolean;

  // ---- Ops defaults ----
  defaultPrepMinutes: number;
  deliveryRadiusKm: number;

  // ---- Rider pay (0083) ----
  /**
   * The rider rate card: base fee, km included, rate per extra km and the
   * minimum per delivery, in rupees. The database applies it when a delivery
   * becomes delivered (`record_rider_earning`); the app uses it only for the
   * "≈ ₹X est." on an offer (`deliveryEarning`). All ₹0 until an admin sets a
   * rate, and on a database without 0083.
   */
  riderRateCard: RateCard;

  // ---- Reviews ----
  /**
   * Days after delivery that a customer may still review an order. Enforced in
   * RLS by `review_window_open()` (0033), not only here — the publishable key
   * lets a customer reach PostgREST without executing our code.
   */
  reviewWindowDays: number;
  /** Hours after posting that a customer may still edit or withdraw a review. */
  reviewEditWindowHours: number;

  // ---- Android app releases (0045) ----
  /**
   * What the rider and customer Android apps are told when they ask
   * `GET /api/app-version`. Both apps are distributed as a direct `.apk`, not
   * through Play, so this is the only channel that can move a fleet off a bad
   * build — see `src/lib/releases/app-version.ts` for how the two version codes
   * become "update available" and "must update".
   *
   * Every code defaults to 1 rather than 0, here and in the 0045 column
   * defaults, so an un-migrated or unreadable backend answers "you are current"
   * for any real installed build instead of force-updating everyone.
   */
  riderApkVersionCode: number;
  /** Oldest rider build still allowed to run. Below it, the app must update. */
  riderApkMinVersionCode: number;
  /** Direct download URL for the latest rider APK. Empty = nothing to offer. */
  riderApkUrl: string;
  /** Release notes shown in the rider app's update prompt. */
  riderApkNotes: string;

  customerApkVersionCode: number;
  /** Oldest customer build still allowed to run. */
  customerApkMinVersionCode: number;
  customerApkUrl: string;
  customerApkNotes: string;

  // ---- New-order alert sounds (0044) ----
  // One setting per role, platform-wide — not per-shop or per-rider. A role
  // plays its uploaded custom sound when `*Url` is set, otherwise its preset;
  // see src/lib/alerts/tones.ts.
  vendorAlertSoundPreset: string;
  vendorAlertSoundUrl: string | null;
  /** Original filename of the custom upload, for display only. */
  vendorAlertSoundName: string | null;
  riderAlertSoundPreset: string;
  riderAlertSoundUrl: string | null;
  riderAlertSoundName: string | null;

  // ---- Legal links (0081) ----
  // Deligro has no published policy or terms yet, so both default to empty and
  // every app hides the link until an admin sets one. https only — see
  // `safeApkUrl`, which the Settings action applies to these as well.
  /** Public link to the privacy policy. Empty = none published. */
  privacyPolicyUrl: string;
  /** Public link to the terms of service. Empty = none published. */
  termsUrl: string;

  // ---- Rider jobs (0082) ----
  /**
   * Seconds a rider has to accept an exclusive offer before dispatch moves on.
   * 60–600, enforced by a CHECK. `EXCLUSIVE_OFFER_MS` is the fallback on a
   * database without the column.
   */
  riderOfferWindowSeconds: number;
  /** When a proof-of-delivery photo is required. */
  podPhotoRule: PodPhotoRule;
  /**
   * Minutes after reaching the customer (and a logged call) before a rider may
   * report them unreachable. 3–30.
   */
  unreachableWaitMinutes: number;
  /** Base URL of the OSRM-compatible routing server. https only. */
  routingBaseUrl: string;
}

/**
 * `platform_settings.pod_photo_rule` (0082): never; cod = cash orders only;
 * always; exceptions = only completions ops approved without the code.
 */
export type PodPhotoRule = "never" | "cod" | "always" | "exceptions";

/** How the customer intends to pay. Mirrors the `payment_method` enum (0025). */
export type PaymentMethod = "cod" | "online";

/**
 * Where the money actually is. Mirrors the `payment_status` enum (0025).
 * Only a verified Razorpay signature moves an order off `pending`.
 */
export type PaymentStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "failed"
  | "refunded";

export interface Banner {
  id: string;
  /** Admin-facing campaign name; also the default headline fallback. */
  name: string;
  headline: string;
  /** Max ~2 lines in the UI — kept short at author time, truncated at render. */
  description: string;
  ctaLabel: string; // "Order Now", "Shop Now", "Explore"…
  kind: BannerKind;
  status: BannerStatus;
  target: BannerTarget;
  placements: BannerPlacement[];
  /** Higher wins ordering within a placement; ties break on `displayOrder`. */
  priority: number;
  displayOrder: number;
  /** Per-banner auto-advance, milliseconds. Clamped to 3–8s at render. */
  autoSlideMs: number;
  /** Landscape/desktop art. */
  imageUrl?: string;
  /** Portrait/mobile art; falls back to `imageUrl`. */
  mobileImageUrl?: string;
  /** Gradient shown under the image while it loads (and if it never does). */
  tint: string;
  /** Small emoji/badge glyph on the art, à la PhotoTile `label`. */
  glyph?: string;
  /** Paid campaigns show "Sponsored · {sponsorName}". */
  sponsorName?: string;
  targeting?: BannerTargeting;
  /** ISO timestamps; undefined = open-ended on that side. */
  startsAt?: string | null;
  endsAt?: string | null;
  analytics?: BannerAnalytics;
}
