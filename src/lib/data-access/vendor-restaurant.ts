import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export const VENDOR_RESTAURANT_COOKIE = "vendor_restaurant_slug";

export interface OwnedRestaurant {
  id: string;
  slug: string;
  name: string;
  isOpen: boolean;
}

/** All restaurants owned by the signed-in vendor. */
export async function listOwnedRestaurants(): Promise<OwnedRestaurant[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("restaurants")
    .select("id, slug, name, is_open")
    .eq("owner_id", user.id)
    .order("name");

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    isOpen: row.is_open,
  }));
}

async function defaultRestaurantId(
  ownedIds: string[]
): Promise<string | undefined> {
  if (ownedIds.length === 0) return undefined;

  const supabase = await createClient();
  const { data } = await supabase
    .from("orders")
    .select("restaurant_id")
    .in("restaurant_id", ownedIds)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.restaurant_id ?? ownedIds[0];
}

/**
 * Active restaurant for this vendor session.
 * Single-owner vendors always get their one shop; multi-owner accounts
 * respect the selection cookie, then fall back to the shop with the latest order.
 */
export async function resolveVendorRestaurant(): Promise<OwnedRestaurant | null> {
  const owned = await listOwnedRestaurants();
  if (owned.length === 0) return null;
  if (owned.length === 1) return owned[0];

  const jar = await cookies();
  const slug = jar.get(VENDOR_RESTAURANT_COOKIE)?.value;
  if (slug) {
    const picked = owned.find((r) => r.slug === slug);
    if (picked) return picked;
  }

  const fallbackId = await defaultRestaurantId(owned.map((r) => r.id));
  return owned.find((r) => r.id === fallbackId) ?? owned[0];
}

/** Toggle store open/closed for the active restaurant. */
export async function setRestaurantOpen(isOpen: boolean): Promise<boolean> {
  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) return false;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .update({ is_open: isOpen })
    .eq("id", restaurant.id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * `offer` is deliberately absent. Since 0041 the badge is derived from the
 * shop's own coupons and the column rejects writes from anyone but
 * `refresh_restaurant_offer()` — so accepting it here would build a patch the
 * database silently drops, which is worse than not offering the field.
 * Promotions are edited at /vendor/promotions.
 */
export interface VendorRestaurantUpdateInput {
  name?: string;
  tagline?: string | null;
  cuisines?: string[];
  imageUrl?: string | null;
  accentTint?: string | null;
  etaMin?: number | null;
  etaMax?: number | null;
  costForTwo?: number | null;
  priceTier?: number;
  /**
   * `restaurants.prep_minutes` (0036) — how long this kitchen takes, as opposed
   * to how long the platform assumes every kitchen takes. Null clears it back to
   * inheriting `platform_settings.default_prep_minutes`.
   */
  prepMinutes?: number | null;
}

export interface VendorPace {
  /** Minutes currently added to what customers are quoted. 0 = not busy. */
  extraMinutes: number;
  /** ISO, when it lapses. Null when not busy. */
  until: string | null;
  /** False on a database that predates 0036 — the control hides itself. */
  supported: boolean;
}

/**
 * The shop's live busy bump, for the vendor's own board.
 *
 * Soft on a missing column rather than throwing: a database without 0036 loses
 * this one control, not the kitchen board it sits on.
 */
export async function getVendorPace(restaurantId: string): Promise<VendorPace> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("busy_until, busy_extra_minutes")
    .eq("id", restaurantId)
    .maybeSingle();

  if (error || !data) {
    return { extraMinutes: 0, until: null, supported: !error };
  }

  const until = data.busy_until as string | null;
  const live = until !== null && Date.parse(until) > Date.now();
  return {
    extraMinutes: live ? Number(data.busy_extra_minutes ?? 0) : 0,
    until: live ? until : null,
    supported: true,
  };
}

/**
 * "We're slammed — add 15 minutes for the next hour."
 *
 * A deadline rather than a flag, so it cannot be left on: the worst case is that
 * it lapses while the kitchen is still busy and the vendor taps it again, which
 * is strictly better than a shop advertising a permanent penalty because someone
 * forgot to clear it. `minutes: 0` clears it now.
 *
 * Bounds mirror the 0036 CHECK constraints — the column is the floor under this,
 * not a substitute for it.
 */
export async function setVendorBusy(input: {
  minutes: number;
  forMinutes?: number;
}): Promise<boolean> {
  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) return false;

  const extra = Math.min(120, Math.max(0, Math.round(input.minutes)));
  const window = Math.min(360, Math.max(1, Math.round(input.forMinutes ?? 60)));

  const supabase = await createClient();
  const { error } = await supabase
    .from("restaurants")
    .update({
      busy_extra_minutes: extra,
      busy_until:
        extra > 0
          ? new Date(Date.now() + window * 60_000).toISOString()
          : null,
    })
    .eq("id", restaurant.id);

  if (error) throw error;
  return true;
}

/** Update storefront fields for the active restaurant. */
export async function updateVendorRestaurant(
  input: VendorRestaurantUpdateInput
): Promise<boolean> {
  const restaurant = await resolveVendorRestaurant();
  if (!restaurant) return false;

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name_required");
    patch.name = name;
  }
  if (input.tagline !== undefined)
    patch.tagline = input.tagline?.trim() || null;
  if (input.cuisines !== undefined) patch.cuisines = input.cuisines;
  if (input.imageUrl !== undefined)
    patch.image_url = input.imageUrl?.trim() || null;
  if (input.accentTint !== undefined)
    patch.accent_tint = input.accentTint?.trim() || null;
  if (input.etaMin !== undefined) patch.eta_min = input.etaMin;
  if (input.etaMax !== undefined) patch.eta_max = input.etaMax;
  if (input.prepMinutes !== undefined) {
    // Null is meaningful — "inherit the platform default" — so this is an
    // explicit null check, not a falsy one that would swallow it.
    patch.prep_minutes =
      input.prepMinutes === null
        ? null
        : Math.min(180, Math.max(1, Math.round(input.prepMinutes)));
  }
  if (input.costForTwo !== undefined) patch.cost_for_two = input.costForTwo;
  if (input.priceTier !== undefined) {
    const tier = Math.min(3, Math.max(1, Math.round(input.priceTier)));
    patch.price_tier = tier;
  }

  if (Object.keys(patch).length === 0) return false;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .update(patch)
    .eq("id", restaurant.id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}
