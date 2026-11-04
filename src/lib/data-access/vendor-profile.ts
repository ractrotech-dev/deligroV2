import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  listOwnedRestaurants,
  resolveVendorRestaurant,
  type OwnedRestaurant,
} from "@/lib/data-access/vendor-restaurant";

export interface VendorRestaurantDetail extends OwnedRestaurant {
  tagline: string | null;
  approved: boolean;
  cuisines: string[];
  rating: number;
  ratingCount: number;
  offer: string | null;
  imageUrl: string | null;
  accentTint: string | null;
  etaMin: number | null;
  etaMax: number | null;
  /** `restaurants.prep_minutes` (0036). Null inherits the platform default. */
  prepMinutes: number | null;
  costForTwo: number | null;
  priceTier: number;
  promoted: boolean;
  createdAt: string | null;
  reviewCount: number;
}

export interface VendorProfileSummary {
  ownerName: string;
  ownerPhone: string | null;
  ownerEmail: string | null;
  memberSince: string;
  initials: string;
  ownedRestaurants: OwnedRestaurant[];
  restaurant: VendorRestaurantDetail | null;
  stats: {
    menuItems: number;
    menuAvailable: number;
    totalOrders: number;
    activeOrders: number;
    deliveredOrders: number;
    cancelledOrders: number;
    lifetimeRevenue: number;
  };
  completeness: {
    score: number;
    missing: string[];
  };
}

function initialsFrom(name: string, phone: string | null): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.slice(-2) || "VR";
}

function computeCompleteness(r: VendorRestaurantDetail | null): {
  score: number;
  missing: string[];
} {
  if (!r) return { score: 0, missing: ["Link a restaurant"] };
  const checks: { ok: boolean; label: string }[] = [
    { ok: Boolean(r.name?.trim()), label: "Store name" },
    { ok: Boolean(r.tagline?.trim()), label: "Tagline" },
    { ok: Boolean(r.imageUrl?.trim()), label: "Cover photo" },
    { ok: r.cuisines.length > 0, label: "Cuisines" },
    // Derived from the shop's own coupons (0041), so this now measures
    // "is a promotion running" rather than "has someone typed a slogan".
    { ok: Boolean(r.offer?.trim()), label: "A live promotion" },
    { ok: r.etaMin != null && r.etaMax != null, label: "Delivery ETA" },
    { ok: r.costForTwo != null && r.costForTwo > 0, label: "Cost for two" },
  ];
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);
  const score = Math.round(
    ((checks.length - missing.length) / checks.length) * 100
  );
  return { score, missing };
}

/** Full vendor + active restaurant profile for `/vendor/profile`. */
export async function getVendorProfileSummary(): Promise<VendorProfileSummary | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, owned] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, phone, created_at")
      .eq("id", user.id)
      .maybeSingle(),
    listOwnedRestaurants(),
  ]);

  const ownerName = profile?.full_name?.trim() || "Restaurant Owner";
  const ownerPhone = profile?.phone ?? user.phone ?? null;
  const memberSince = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
      })
    : new Date(user.created_at).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
      });

  const active = await resolveVendorRestaurant();
  let restaurant: VendorRestaurantDetail | null = null;
  let stats = {
    menuItems: 0,
    menuAvailable: 0,
    totalOrders: 0,
    activeOrders: 0,
    deliveredOrders: 0,
    cancelledOrders: 0,
    lifetimeRevenue: 0,
  };

  if (active) {
    const BASE_COLUMNS =
      "id, slug, name, tagline, is_open, approved, cuisines, rating, rating_count, offer, image_url, accent_tint, eta_min, eta_max, cost_for_two, price_tier, promoted, created_at";
    // `prep_minutes` arrives with 0036. Asked for separately so a database
    // without it loses the field, not the whole profile screen.
    const readRestaurant = async () => {
      const withPace = await supabase
        .from("restaurants")
        .select(`${BASE_COLUMNS}, prep_minutes`)
        .eq("id", active.id)
        .maybeSingle();
      if (!withPace.error) return withPace;
      return supabase
        .from("restaurants")
        .select(BASE_COLUMNS)
        .eq("id", active.id)
        .maybeSingle();
    };

    const [{ data: row }, reviewsCount] = await Promise.all([
      readRestaurant(),
      supabase
        .from("reviews")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id),
    ]);

    if (row) {
      restaurant = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        isOpen: row.is_open,
        tagline: row.tagline,
        approved: row.approved,
        cuisines: row.cuisines ?? [],
        rating: Number(row.rating),
        ratingCount: row.rating_count,
        offer: row.offer,
        imageUrl: row.image_url,
        accentTint: row.accent_tint,
        etaMin: row.eta_min,
        etaMax: row.eta_max,
        prepMinutes:
          (row as { prep_minutes?: number | null }).prep_minutes ?? null,
        costForTwo: row.cost_for_two,
        priceTier: row.price_tier,
        promoted: row.promoted,
        createdAt: row.created_at,
        reviewCount: reviewsCount.count ?? 0,
      };
    }

    const [
      { count: menuItems },
      { count: menuAvailable },
      { count: totalOrders },
      { count: activeOrders },
      { count: deliveredOrders },
      { count: cancelledOrders },
      { data: deliveredTotals },
    ] = await Promise.all([
      supabase
        .from("menu_items")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id),
      supabase
        .from("menu_items")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id)
        .eq("available", true),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id)
        .in("status", ["placed", "kitchen", "ready", "on_the_way"]),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id)
        .eq("status", "delivered"),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", active.id)
        .eq("status", "cancelled"),
      supabase
        .from("orders")
        .select("total")
        .eq("restaurant_id", active.id)
        .eq("status", "delivered"),
    ]);

    stats = {
      menuItems: menuItems ?? 0,
      menuAvailable: menuAvailable ?? 0,
      totalOrders: totalOrders ?? 0,
      activeOrders: activeOrders ?? 0,
      deliveredOrders: deliveredOrders ?? 0,
      cancelledOrders: cancelledOrders ?? 0,
      lifetimeRevenue: (deliveredTotals ?? []).reduce(
        (s, o) => s + Number(o.total),
        0
      ),
    };
  }

  return {
    ownerName,
    ownerPhone,
    ownerEmail: user.email ?? null,
    memberSince,
    initials: initialsFrom(ownerName, ownerPhone),
    ownedRestaurants: owned,
    restaurant,
    stats,
    completeness: computeCompleteness(restaurant),
  };
}
