import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { getOffer, updateOfferOps } from "@/lib/data-access/manager-offers";
import { parseUpdateOfferBody } from "@/lib/ops/offer-contract";
import { actionFailed, actorOf, badField, failure, loadFailed, notFound, parseOptionalRange } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

const CODE = /^[A-Z0-9]{3,20}$/;

/**
 * GET /api/manager/offers/[code]?from&to — the code, its use over the range
 * (default: the last 30 days) and its change history (§9.7, §9.9, §9.10).
 * PATCH — edit its terms with the current `expectedUpdatedAt` and a reason.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const ctx = await managerApiContext("manager.offers.manage");
  if (ctx instanceof Response) return ctx;
  const code = decodeURIComponent((await params).code).toUpperCase();
  if (!CODE.test(code)) return notFound();
  const range = parseOptionalRange(new URL(request.url).searchParams);
  if (!range.ok) return badField(range.field);
  try {
    const detail = await getOffer(ctx.scope, code, range.range, new Date(), ctx.profile.role === "admin");
    return detail ? NextResponse.json(detail) : notFound();
  } catch {
    return loadFailed();
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const ctx = await managerApiContext("manager.offers.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "offers");
  if (limited) return limited;
  const code = decodeURIComponent((await params).code).toUpperCase();
  if (!CODE.test(code)) return notFound();
  const now = new Date();
  const parsed = parseUpdateOfferBody(await readJsonObject(request), now);
  if (!parsed.ok) return badField(parsed.field, parsed.error);
  let r;
  try {
    r = await updateOfferOps(actorOf(ctx.profile), ctx.scope, code, parsed);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getOffer(ctx.scope, code, null, now, ctx.profile.role === "admin").catch(() => null);
  return NextResponse.json({ offer: detail?.offer ?? null });
}
