import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorFeatureContext, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { createMarketingRequest, listShopMarketing, MarketingNotMigratedError } from "@/lib/data-access/marketing";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { parseMarketingRequest } from "@/lib/vendor/growth-input";

export const dynamic = "force-dynamic";

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * GET /api/vendor/marketing — the shop's requests, newest first, each with its
 * timeline. Both methods answer 403 feature_disabled when the shop's
 * `vendor.marketing` switch is off.
 */
export async function GET() {
  const ctx = await vendorFeatureContext("vendor.marketing");
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-growth-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    return NextResponse.json({ requests: await listShopMarketing(ctx.restaurant.id) });
  } catch (e) {
    if (e instanceof MarketingNotMigratedError) return NextResponse.json({ error: "needs_migration" }, { status: 409 });
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/vendor/marketing — ask Deligro for a campaign: { kind:
 * banner|featured|discount_offer|social_media|push_campaign|other, title,
 * details, budget?, startsOn?, endsOn? }. → 201 { request }.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.marketing", "vendor-growth");
  if (ctx instanceof Response) return ctx;

  const input = parseMarketingRequest(await readJsonBody(request), istToday());
  if ("error" in input) return badRequest(input.error);
  try {
    const created = await createMarketingRequest(ctx.restaurant.id, ctx.profile.id, input);
    return NextResponse.json({ request: created }, { status: 201 });
  } catch (e) {
    if (e instanceof MarketingNotMigratedError) return NextResponse.json({ error: "needs_migration" }, { status: 409 });
    return vendorWriteError(e);
  }
}
