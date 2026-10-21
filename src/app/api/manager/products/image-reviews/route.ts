import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listImageReviews } from "@/lib/data-access/manager-products";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/products/image-reviews — vendor dish photos waiting for a
 * look (§12.7), newest first: a new dish's photo or a changed one, while it is
 * still the photo customers see. manager.products.moderate.
 *
 * Query: vendor (uuid), before (change id, from nextBefore), limit (1–100, default 50).
 * → 200 { items: [{ changeId, product: ProductListItem, previousImageUrl, imageUrl, changedAt, changedBy }], nextBefore }
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.products.moderate");
  if (ctx instanceof Response) return ctx;

  const params = new URL(request.url).searchParams;
  const vendor = params.get("vendor");
  if (vendor !== null && !isUuid(vendor)) return NextResponse.json({ error: "bad_request", field: "vendor" }, { status: 400 });
  const beforeRaw = params.get("before");
  const before = beforeRaw === null ? null : Number(beforeRaw);
  if (before !== null && (!Number.isInteger(before) || before < 1)) return NextResponse.json({ error: "bad_request", field: "before" }, { status: 400 });
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return NextResponse.json({ error: "bad_request", field: "limit" }, { status: 400 });

  try {
    return NextResponse.json(await listImageReviews(ctx.scope, { vendor: vendor?.toLowerCase() ?? null, before, limit }));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
