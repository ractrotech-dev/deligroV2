import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { createMarketingRequestOps, getMarketingRequest, listMarketingRequests, syncCampaigns } from "@/lib/data-access/manager-marketing";
import { parseCreateRequestBody, parseRequestQuery } from "@/lib/ops/marketing-contract";
import { actionFailed, actorOf, badField, failure, loadFailed } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/marketing/requests — vendor marketing requests in the
 * manager's zones (§8.1), newest first, with counts per status.
 * POST — record a request on a vendor's behalf, after a phone call.
 * Contract: the Phase 7 plan, "Marketing — requests".
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const parsed = parseRequestQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return badField(parsed.field);
  // Campaign statuses follow their windows; a list read nudges the scheduler (throttled).
  await syncCampaigns(new Date()).catch(() => {});
  try {
    return NextResponse.json(await listMarketingRequests(ctx.scope, parsed.q));
  } catch {
    return loadFailed();
  }
}

export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.marketing.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "marketing");
  if (limited) return limited;
  const parsed = parseCreateRequestBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field);
  let r;
  try {
    r = await createMarketingRequestOps(actorOf(ctx.profile), ctx.scope, parsed.body);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getMarketingRequest(ctx.scope, r.id!, new Date()).catch(() => null);
  return NextResponse.json({ request: detail?.request ?? null }, { status: 201 });
}
