import "server-only";
import { NextResponse } from "next/server";
import { getProfile, type Profile } from "@/lib/auth";
import { hasVendorAccess } from "@/lib/auth/vendor-access";
import {
  listOwnedRestaurants,
  resolveVendorRestaurant,
  type OwnedRestaurant,
} from "@/lib/data-access/vendor-restaurant";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { FeatureKey } from "@/lib/features/catalog";
import { featureOffResponse, vendorFeatureOn } from "@/lib/features/guards.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * The gate every Partner-app route opens with. The shop is resolved on the
 * server from the session (and the `vendor_restaurant_slug` cookie for owners
 * of several shops), never taken from the request, so a vendor can only ever
 * act on a shop they own. RLS underneath enforces the same.
 */
export interface VendorApiContext {
  profile: Profile;
  /** The shop this request acts on. */
  restaurant: OwnedRestaurant;
  /** Every shop the signed-in account owns. */
  shops: OwnedRestaurant[];
}

/** The context, or the refusal to return as-is. */
export async function vendorApiContext(): Promise<VendorApiContext | Response> {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!(await hasVendorAccess(profile))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // An admin passes hasVendorAccess without owning a shop; there is nothing
  // for the Partner app to show them.
  const shops = await listOwnedRestaurants();
  const restaurant = await resolveVendorRestaurant(shops);
  if (!restaurant) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
  }

  return { profile, restaurant, shops };
}

/**
 * The gate a Partner-app read behind a shop switch opens with: the vendor
 * context, then 403 feature_disabled when the switch is off for this shop.
 */
export async function vendorFeatureContext(feature: FeatureKey): Promise<VendorApiContext | Response> {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  if (!(await vendorFeatureOn(feature))) return featureOffResponse(feature);
  return ctx;
}

/** Write buckets, per signed-in account, per minute. */
export const VENDOR_WRITE_LIMITS = {
  "vendor-store": 30,
  "vendor-menu": 120,
  /** Offers, marketing requests, review replies. */
  "vendor-growth": 30,
  /** Support tickets and messages. */
  "vendor-support": 20,
} as const;

/**
 * The gate every Partner-app write opens with: the vendor context, then the
 * shop's feature switch, then the account's rate-limit bucket. The context,
 * or the refusal to return as-is.
 */
export async function vendorWriteContext(
  /** Null for a write no shop switch governs. */
  feature: FeatureKey | null,
  bucket: keyof typeof VENDOR_WRITE_LIMITS
): Promise<VendorApiContext | Response> {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  if (feature && !(await vendorFeatureOn(feature))) return featureOffResponse(feature);
  const limit = await rateLimit(`${bucket}:${ctx.profile.id}`, VENDOR_WRITE_LIMITS[bucket], 60_000);
  if (!limit.ok) return tooManyRequests(limit);
  return ctx;
}

/** The request's JSON body, or null when it isn't JSON. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Errors the data layer throws on purpose, as the 4xx the app can explain. */
const KNOWN_REFUSALS: Record<string, number> = {
  needs_migration: 409,
  invalid_transition: 409,
  name_required: 400,
  invalid_price: 400,
  in_the_past: 400,
  too_many_holidays: 409,
};

/**
 * The response for a failed write. Known refusals keep their code; anything
 * else is a plain 500 with no detail, so database text never reaches a client.
 */
export function vendorWriteError(e: unknown): Response {
  const code = e instanceof Error ? e.message : "";
  const status = KNOWN_REFUSALS[code];
  if (status) return NextResponse.json({ error: code }, { status });
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}

/** 400 with the validator's code. */
export function badRequest(error: string): Response {
  return NextResponse.json({ error }, { status: 400 });
}
