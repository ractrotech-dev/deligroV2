import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid, narrowScope } from "@/lib/auth/manager-scope";
import { listProductCategories } from "@/lib/data-access/manager-products";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/products/categories?zone=&vendor= — menu categories across
 * the manager's shops with dish, unavailable and shop counts, and whether each
 * is a restricted category (§12.4). Dishes without a category are "Uncategorised".
 *
 * → 200 { categories }   → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const sp = new URL(request.url).searchParams;
  const zone = sp.get("zone");
  const vendor = sp.get("vendor");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });
  if (vendor && !isUuid(vendor)) return NextResponse.json({ error: "bad_request", field: "vendor" }, { status: 400 });

  try {
    const categories = await listProductCategories(narrowScope(ctx.scope, zone), vendor ? vendor.toLowerCase() : null);
    return NextResponse.json({ categories });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
