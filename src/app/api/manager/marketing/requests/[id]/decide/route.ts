import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { decideMarketingRequestOps, getMarketingRequest, requestTypeOf } from "@/lib/data-access/manager-marketing";
import { parseDecideBody } from "@/lib/ops/marketing-contract";
import { actionFailed, actorOf, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/marketing/requests/[id]/decide — approve (creating the
 * campaign or code in the same transaction) or reject with remarks (§8.2–8.3).
 * A replayed clientActionId answers 200 and changes nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing");
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const id = raw.toLowerCase();
  const now = new Date();
  const type = await requestTypeOf(ctx.scope, id).catch(() => null);
  if (!type) return notFound();
  const parsed = parseDecideBody(await readJsonObject(request), type, now);
  if (!parsed.ok) return badField(parsed.field, parsed.error);
  let r;
  try {
    r = await decideMarketingRequestOps(actorOf(ctx.profile), ctx.scope, id, parsed.body);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getMarketingRequest(ctx.scope, id, now).catch(() => null);
  return NextResponse.json(detail ?? { request: null, campaign: null, offer: null });
}
