import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { renameCategory } from "@/lib/data-access/vendor-menu";
import { MENU_LIMITS } from "@/lib/vendor/menu-input";

/**
 * POST /api/vendor/menu/categories — { from, to }: every dish in category
 * `from` moves to `to`. Renaming onto an existing category merges the two.
 * → 200 { moved }.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.menu_edit", "vendor-menu");
  if (ctx instanceof Response) return ctx;

  const body = (await readJsonBody(request)) as { from?: unknown; to?: unknown } | null;
  const ok = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= MENU_LIMITS.category;
  if (!body || !ok(body.from) || !ok(body.to)) return badRequest("invalid_category");

  try {
    const moved = await renameCategory(body.from as string, body.to as string);
    return NextResponse.json({ ok: true, moved });
  } catch (e) {
    return vendorWriteError(e);
  }
}
