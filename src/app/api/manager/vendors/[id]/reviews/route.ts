import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listVendorReviews } from "@/lib/data-access/manager-vendors";
import { parseLimit } from "@/lib/ops/vendor-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/vendors/[id]/reviews?cursor=&limit= — the shop's reviews,
 * newest first (§4.10). Customers appear by first name only.
 *
 * → 200 { items: ReviewItem[], nextCursor }   → 400 { error: "bad_request", field }
 * → 404 { error: "not_found" }   → 500 { error: "load_failed" }
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.vendors.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const sp = new URL(request.url).searchParams;
  const limit = parseLimit(sp.get("limit"));
  if (limit === null) return NextResponse.json({ error: "bad_request", field: "limit" }, { status: 400 });

  try {
    const page = await listVendorReviews(ctx.scope, id.toLowerCase(), sp.get("cursor"), limit);
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(page);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
