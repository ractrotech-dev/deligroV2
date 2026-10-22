import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getMarketingRequest, progressMarketingRequestOps } from "@/lib/data-access/manager-marketing";
import { parseProgressBody } from "@/lib/ops/marketing-contract";
import { actionFailed, actorOf, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/** POST …/requests/[id]/progress — move a request with no campaign along by hand. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing");
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const id = raw.toLowerCase();
  const parsed = parseProgressBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field);
  let r;
  try {
    r = await progressMarketingRequestOps(actorOf(ctx.profile), ctx.scope, id, parsed.status, parsed.remarks, parsed.clientActionId);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getMarketingRequest(ctx.scope, id, new Date()).catch(() => null);
  return NextResponse.json({ request: detail?.request ?? null });
}
