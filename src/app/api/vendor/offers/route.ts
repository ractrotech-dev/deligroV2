import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorApiContext, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { createPromotion, PromotionsNotMigratedError } from "@/lib/data-access/promotions";
import { getVendorOffers } from "@/lib/data-access/vendor-offers";
import { featureOffResponse, vendorFeatureOn } from "@/lib/features/guards.server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { validatePromotion } from "@/lib/promotion-rules";
import { parseOfferBody } from "@/lib/vendor/growth-input";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/offers — the shop's own promo codes (with status and what
 * each brought in: orders, sales, discount) and the Deligro-funded
 * promotions running at the shop, read-only. Follows `vendor.promotions`.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  if (!(await vendorFeatureOn("vendor.promotions"))) return featureOffResponse("vendor.promotions");

  const limit = await rateLimit(`vendor-growth-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    return NextResponse.json(await getVendorOffers(ctx.restaurant.id));
  } catch (e) {
    if (e instanceof PromotionsNotMigratedError) return NextResponse.json({ error: "needs_migration" }, { status: 409 });
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/vendor/offers — a new code the shop pays for: { code, label?,
 * kind: percent|flat, value, minOrder?, maxDiscount?, startsAt?, expiresAt?,
 * maxPerCustomer?, maxRedemptions?, active? }. → 201 { code }; 409
 * `code_taken` when the code exists anywhere on Deligro.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext("vendor.promotions", "vendor-growth");
  if (ctx instanceof Response) return ctx;

  const draft = parseOfferBody(await readJsonBody(request), ctx.restaurant.id);
  if ("error" in draft) return badRequest(draft.error);
  const problem = validatePromotion(draft);
  if (problem) return NextResponse.json({ error: "invalid_offer", message: problem }, { status: 400 });

  try {
    await createPromotion(draft);
    return NextResponse.json({ code: draft.code }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? "");
    if (msg.includes("duplicate key") || (e as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { error: "code_taken", message: `${draft.code} is already taken. Codes are unique across Deligro — try adding your shop's name.` },
        { status: 409 }
      );
    }
    return vendorWriteError(e);
  }
}
