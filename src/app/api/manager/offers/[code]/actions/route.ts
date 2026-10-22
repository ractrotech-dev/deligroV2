import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { getOffer, offerActionOps } from "@/lib/data-access/manager-offers";
import { parseOfferActionBody } from "@/lib/ops/offer-contract";
import { actionFailed, actorOf, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

const CODE = /^[A-Z0-9]{3,20}$/;

/**
 * POST /api/manager/offers/[code]/actions — switch a code on or off, with a
 * reason. An expired or used-up code cannot be switched on (409 expired /
 * exhausted): give it a new end with a PATCH first (§9.8).
 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const ctx = await managerApiContext("manager.offers.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "offers");
  if (limited) return limited;
  const code = decodeURIComponent((await params).code).toUpperCase();
  if (!CODE.test(code)) return notFound();
  const parsed = parseOfferActionBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field, parsed.error);
  let r;
  try {
    r = await offerActionOps(actorOf(ctx.profile), ctx.scope, code, parsed.action, parsed.reason, parsed.clientActionId);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getOffer(ctx.scope, code, null, new Date(), ctx.profile.role === "admin").catch(() => null);
  return NextResponse.json({ offer: detail?.offer ?? null });
}
