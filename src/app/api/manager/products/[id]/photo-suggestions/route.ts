import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { scopedProductRow } from "@/lib/data-access/manager-products";
import { listFoodImages, suggestImages } from "@/lib/data-access/food-images";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/products/[id]/photo-suggestions?q= — Deligro library photos
 * to put on this dish: the best matches for its name when `q` is empty, else a
 * search. Needs manager.products.replace_photo.
 *
 * → 200 { items: { id, title, imageUrl }[] }   → 403   → 404 not_found
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.products.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.permissions["manager.products.replace_photo"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.products.replace_photo" }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  try {
    const row = await scopedProductRow(ctx.scope, id.toLowerCase());
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const images = q ? await listFoodImages({ query: q, limit: 24 }) : (await suggestImages(row.name, 12)).map((s) => s.image);
    return NextResponse.json({ items: images.map((i) => ({ id: i.id, title: i.title, imageUrl: i.imageUrl })) });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
