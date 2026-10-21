import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listManagerProducts } from "@/lib/data-access/manager-products";
import { parseProductQuery } from "@/lib/ops/product-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/products — dishes across the shops in the manager's zones
 * (§12.1–12.3), by name, keyset-paged.
 *
 * Query: q, vendor, category ("Uncategorised" for none), availability
 * (available | unavailable | out_of_stock | low_stock), approval
 * (pending | approved | rejected), flagged=open, hidden=true, zone, cursor,
 * limit (1–100, default 50).
 *
 * → 200 { items: ProductListItem[], nextCursor, counts }
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;

  const parsed = parseProductQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    return NextResponse.json(await listManagerProducts(ctx.scope, parsed.query));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
