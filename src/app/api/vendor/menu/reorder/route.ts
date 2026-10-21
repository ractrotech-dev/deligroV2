import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { reorderMenuItems } from "@/lib/data-access/vendor-menu";
import { isUuid } from "@/lib/vendor/uuid";

/**
 * POST /api/vendor/menu/reorder — { ids: [uuid…] } in display order (at most
 * 500, no repeats). Ids that aren't this shop's are ignored.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;

  const body = (await readJsonBody(request)) as { ids?: unknown } | null;
  const ids = body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 500 ||
    !ids.every((id) => typeof id === "string" && isUuid(id)) ||
    new Set(ids).size !== ids.length
  ) {
    return badRequest("invalid_ids");
  }

  try {
    await reorderMenuItems(ids as string[]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return vendorWriteError(e);
  }
}
