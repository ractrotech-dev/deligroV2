import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorApiContext, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { getVendorStore } from "@/lib/data-access/vendor-store";
import { updateVendorRestaurant } from "@/lib/data-access/vendor-restaurant";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { getSettings } from "@/lib/settings";
import { parseStoreUpdate } from "@/lib/vendor/store-input";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/store — the active shop's storefront (VendorStore), plus
 * `defaultPrepMinutes` and which controls this shop may use.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  try {
    const [store, settings, canEdit, canToggle, canBusy] = await Promise.all([
      getVendorStore(ctx.restaurant),
      getSettings(),
      vendorFeatureOn("vendor.shop_profile"),
      vendorFeatureOn("vendor.open_toggle"),
      vendorFeatureOn("vendor.busy_mode"),
    ]);
    if (!store) return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
    return NextResponse.json({
      store,
      defaultPrepMinutes: settings.defaultPrepMinutes,
      can: { edit: canEdit, openClose: canToggle, busy: canBusy },
    });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * PATCH /api/vendor/store — change any of: name, tagline, description,
 * cuisines, imageUrl, shopPhone, address+lat+lng (together), landmark,
 * pincode, openingTime+closingTime (together; both null clears), weeklyOff
 * (day names), deliveryAvailable, selfPickup, prepMinutes (null = default).
 * Only the active shop changes. → 200 { ok, store }.
 */
export async function PATCH(request: Request) {
  const ctx = await vendorWriteContext("vendor.shop_profile", "vendor-store");
  if (ctx instanceof Response) return ctx;

  const update = parseStoreUpdate(await readJsonBody(request));
  if ("error" in update) return badRequest(update.error);
  if (Object.keys(update).length === 0) return badRequest("nothing_to_change");

  try {
    await updateVendorRestaurant(update);
    return NextResponse.json({ ok: true, store: await getVendorStore(ctx.restaurant) });
  } catch (e) {
    return vendorWriteError(e);
  }
}
