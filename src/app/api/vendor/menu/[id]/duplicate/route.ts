import { NextResponse } from "next/server";
import { vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { duplicateMenuItem } from "@/lib/data-access/vendor-menu";
import { isUuid } from "@/lib/vendor/uuid";

/**
 * POST /api/vendor/menu/:id/duplicate — copy a dish as "Name (copy)", with
 * its schedule and options but not its stock count. → 201 { id }.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const copy = await duplicateMenuItem(id);
    return copy
      ? NextResponse.json({ id: copy }, { status: 201 })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return vendorWriteError(e);
  }
}
