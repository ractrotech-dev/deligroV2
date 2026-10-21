import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { deleteMenuItem, updateMenuItem } from "@/lib/data-access/vendor-menu";
import { parseMenuItemBody } from "@/lib/vendor/menu-input";
import { isUuid } from "@/lib/vendor/uuid";

type Params = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

/**
 * PATCH /api/vendor/menu/:id — change any dish fields (parseMenuItemBody,
 * partial). Only this shop's dishes; 404 otherwise. 409 `needs_migration`
 * for stock/schedule fields before 0062.
 */
export async function PATCH(request: Request, { params }: Params) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const input = parseMenuItemBody(await readJsonBody(request), true);
  if ("error" in input) return badRequest(input.error);
  if (Object.keys(input).length === 0) return badRequest("nothing_to_change");

  try {
    return (await updateMenuItem(id, input)) ? NextResponse.json({ ok: true }) : notFound();
  } catch (e) {
    return vendorWriteError(e);
  }
}

/** DELETE /api/vendor/menu/:id — remove the dish. Past orders keep their lines. */
export async function DELETE(_request: Request, { params }: Params) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  try {
    return (await deleteMenuItem(id)) ? NextResponse.json({ ok: true }) : notFound();
  } catch (e) {
    return vendorWriteError(e);
  }
}
