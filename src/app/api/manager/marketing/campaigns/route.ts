import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { createCampaignOps, getCampaign, listCampaigns, syncCampaigns } from "@/lib/data-access/manager-marketing";
import { parseCampaignQuery, parseCreateCampaignBody } from "@/lib/ops/marketing-contract";
import { actionFailed, actorOf, badField, failure, loadFailed } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/marketing/campaigns — scheduled, active and expired
 * campaigns in scope (§8.12), with headline figures.
 * POST — create a campaign Deligro runs itself, or one a vendor's approved
 * request pays for (consent checked in the database).
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const parsed = parseCampaignQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return badField(parsed.field);
  const now = new Date();
  await syncCampaigns(now).catch(() => {});
  try {
    return NextResponse.json(await listCampaigns(ctx.scope, parsed.q, now));
  } catch {
    return loadFailed();
  }
}

export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing");
  if (limited) return limited;
  const now = new Date();
  const parsed = parseCreateCampaignBody(await readJsonObject(request), now);
  if (!parsed.ok) return badField(parsed.field);
  let r;
  try {
    r = await createCampaignOps(actorOf(ctx.profile), ctx.scope, parsed.input, parsed.clientActionId);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getCampaign(ctx.scope, r.id!, now, null).catch(() => null);
  return NextResponse.json({ campaign: detail?.campaign ?? null }, { status: 201 });
}
