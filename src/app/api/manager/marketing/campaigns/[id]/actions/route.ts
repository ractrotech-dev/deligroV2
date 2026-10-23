import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { campaignActionOps, getCampaign } from "@/lib/data-access/manager-marketing";
import { parseCampaignActionBody } from "@/lib/ops/marketing-contract";
import { actionFailed, actorOf, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/** POST …/campaigns/[id]/actions — cancel before start, or end now while running. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing");
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const id = raw.toLowerCase();
  const parsed = parseCampaignActionBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field, parsed.error);
  let r;
  try {
    r = await campaignActionOps(actorOf(ctx.profile), ctx.scope, id, parsed.action, parsed.reason, parsed.clientActionId);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getCampaign(ctx.scope, id, new Date(), null).catch(() => null);
  return NextResponse.json({ campaign: detail?.campaign ?? null });
}
