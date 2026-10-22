import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { createOfferOps, getOffer, listOffers } from "@/lib/data-access/manager-offers";
import { parseCreateOfferBody, parseOfferQuery } from "@/lib/ops/offer-contract";
import { actionFailed, actorOf, badField, failure, loadFailed } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/offers — the codes a manager may see (§9), by state, with
 * use; platform-wide codes are listed read-only.
 * POST — create a code (§9.1–9.6). Scope, funding consent and limits are
 * enforced in the database (0161); every manager code must end.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.offers.manage");
  if (ctx instanceof Response) return ctx;
  const parsed = parseOfferQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return badField(parsed.field);
  try {
    return NextResponse.json(await listOffers(ctx.scope, parsed.q, new Date()));
  } catch {
    return loadFailed();
  }
}

export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.offers.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "offers");
  if (limited) return limited;
  const now = new Date();
  const admin = ctx.profile.role === "admin";
  const parsed = parseCreateOfferBody(await readJsonObject(request), now, admin);
  if (!parsed.ok) return badField(parsed.field);
  let r;
  try {
    r = await createOfferOps(actorOf(ctx.profile), parsed.terms, parsed.clientActionId);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const detail = await getOffer(ctx.scope, parsed.terms.code, null, now, admin).catch(() => null);
  return NextResponse.json({ offer: detail?.offer ?? null }, { status: 201 });
}
