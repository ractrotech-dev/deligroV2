import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getCampaign, updateCampaignOps } from "@/lib/data-access/manager-marketing";
import { parseCampaignUpdateBody } from "@/lib/ops/marketing-contract";
import { actionFailed, actorOf, badField, failure, loadFailed, notFound, parseOptionalRange } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/marketing/campaigns/[id]?from&to — the campaign and its
 * performance (§8.10–8.11); the default range is its window clipped to today.
 * PATCH — edit it. Before start anything but kind and request; after start
 * only the end, budget, notes and banner, with a reason (enforced in 0160).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const range = parseOptionalRange(new URL(request.url).searchParams);
  if (!range.ok) return badField(range.field);
  try {
    const detail = await getCampaign(ctx.scope, id.toLowerCase(), new Date(), range.range);
    return detail ? NextResponse.json(detail) : notFound();
  } catch {
    return loadFailed();
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing");
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const id = raw.toLowerCase();
  const parsed = parseCampaignUpdateBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field);
  let r;
  try {
    r = await updateCampaignOps(actorOf(ctx.profile), ctx.scope, id, parsed);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getCampaign(ctx.scope, id, new Date(), null).catch(() => null);
  return NextResponse.json({ campaign: detail?.campaign ?? null });
}
