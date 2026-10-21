import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorApiContext, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import {
  createMenuItem,
  listOwnedMenuItems,
  menuInventorySupported,
  type MenuItemInput,
} from "@/lib/data-access/vendor-menu";
import { vendorFeatureOn } from "@/lib/features/guards.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { parseMenuItemBody } from "@/lib/vendor/menu-input";
import { menuItemJson } from "@/lib/vendor/menu-json";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/menu — the active shop's whole menu with sales, stock,
 * schedules and options. → { restaurantId, categories, items,
 * inventorySupported, canEdit }.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-menu-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const [menu, canEdit] = await Promise.all([listOwnedMenuItems(), vendorFeatureOn("vendor.menu_edit")]);
    if (!menu) return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
    return NextResponse.json({
      restaurantId: menu.restaurantId,
      categories: menu.categories,
      items: menu.items.map(menuItemJson),
      inventorySupported: menuInventorySupported(),
      canEdit,
    });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/** POST /api/vendor/menu — add a dish (parseMenuItemBody). → 201 { id }. */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;

  const input = parseMenuItemBody(await readJsonBody(request), false);
  if ("error" in input) return badRequest(input.error);

  try {
    const id = await createMenuItem(input as MenuItemInput);
    if (!id) return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return vendorWriteError(e);
  }
}
