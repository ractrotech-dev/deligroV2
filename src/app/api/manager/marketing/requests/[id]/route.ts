import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getMarketingRequest } from "@/lib/data-access/manager-marketing";
import { loadFailed, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/** GET /api/manager/marketing/requests/[id] — one request, its campaign and its code. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  try {
    const detail = await getMarketingRequest(ctx.scope, id.toLowerCase(), new Date());
    return detail ? NextResponse.json(detail) : notFound();
  } catch {
    return loadFailed();
  }
}
