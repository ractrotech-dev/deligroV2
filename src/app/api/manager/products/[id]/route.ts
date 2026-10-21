import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getManagerProductDetail } from "@/lib/data-access/manager-products";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/products/[id] — one dish in the manager's zones: listing,
 * sizes and add-ons, moderation state, change history, flags, the last 30
 * days' sales and availability, and the actions this manager may take
 * (§12.2–12.10).
 *
 * → 200 { product }   → 404 { error: "not_found" }   → 500 { error: "load_failed" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const product = await getManagerProductDetail(ctx.scope, id.toLowerCase(), { permissions: ctx.permissions, now: new Date() });
    if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ product });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
