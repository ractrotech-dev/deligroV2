import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { loadMenuOptions, replaceMenuOptions } from "@/lib/data-access/vendor-menu";
import { parseMenuOptions } from "@/lib/vendor/menu-input";
import { isUuid } from "@/lib/vendor/uuid";

/**
 * PUT /api/vendor/menu/:id/options — the dish's whole set of sizes and add-on
 * groups: { variants: [{ id?, name, price, available? }], addonGroups: [{ id?,
 * name, minSelect, maxSelect, addons: [{ id?, name, price, available? }] }] }.
 * Rows sent with their id are kept (carts stay valid); rows left out are
 * removed. Variant price is the full price of that size. → 200 { variants,
 * addonGroups }; 409 `needs_migration` before 0062.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const input = parseMenuOptions(await readJsonBody(request));
  if ("error" in input) return badRequest(input.error);

  try {
    if (!(await replaceMenuOptions(id, input))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const saved = (await loadMenuOptions([id])).get(id) ?? { variants: [], addonGroups: [] };
    return NextResponse.json(saved);
  } catch (e) {
    return vendorWriteError(e);
  }
}
