import { NextResponse } from "next/server";
import { vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { deleteHoliday } from "@/lib/data-access/vendor-store";
import { isUuid } from "@/lib/vendor/uuid";

/** DELETE /api/vendor/store/holidays/:id — 404 when it isn't this shop's. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorWriteContext("vendor.open_toggle", "vendor-store");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const ok = await deleteHoliday(ctx.restaurant.id, id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return vendorWriteError(e);
  }
}
