import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { depositPhotoUrl } from "@/lib/data-access/manager-cash";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/cash/deposits/[id]/photo — a 60-second link to the receipt
 * photo a rider attached to a deposit, after the scope check. Needs manager.cash.
 *
 * → 200 { url, expiresAt }   → 404 not_found (no such deposit, out of scope, or no photo)
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.cash");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const link = await depositPhotoUrl(ctx.scope, id.toLowerCase());
    if (!link) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(link);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
