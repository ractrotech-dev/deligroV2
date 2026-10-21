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
