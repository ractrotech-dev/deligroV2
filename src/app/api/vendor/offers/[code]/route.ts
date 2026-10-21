import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { deletePromotion, getPromotion, setPromotionActive, updatePromotion } from "@/lib/data-access/promotions";
import { normalizeCode, validatePromotion } from "@/lib/promotion-rules";
import { parseOfferBody } from "@/lib/vendor/growth-input";

type Params = { params: Promise<{ code: string }> };

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

/** The code, when it belongs to the session's shop; RLS says the same underneath. */
async function owned(code: string, restaurantId: string) {
  const p = await getPromotion(code);
  return p && p.restaurantId === restaurantId && p.fundedBy === "vendor" ? p : null;
}

/**
 * PATCH /api/vendor/offers/:code — { active } pauses or resumes; any other
 * body is a full edit (same fields as create; the code itself, the shop and
 * who pays never change).
 */
export async function PATCH(request: Request, { params }: Params) {
  const ctx = await vendorWriteContext("vendor.promotions", "vendor-growth");
  if (ctx instanceof Response) return ctx;
  const code = normalizeCode(decodeURIComponent((await params).code));
  if (!/^[A-Z0-9]{4,24}$/.test(code)) return notFound();

  const body = (await readJsonBody(request)) as Record<string, unknown> | null;
  try {
    if (!(await owned(code, ctx.restaurant.id))) return notFound();
    if (body && Object.keys(body).length === 1 && typeof body.active === "boolean") {
      await setPromotionActive(code, body.active);
      return NextResponse.json({ ok: true });
    }
    const draft = parseOfferBody({ ...(body ?? {}), code }, ctx.restaurant.id);
    if ("error" in draft) return badRequest(draft.error);
    const problem = validatePromotion(draft);
    if (problem) return NextResponse.json({ error: "invalid_offer", message: problem }, { status: 400 });
    await updatePromotion(code, draft);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return vendorWriteError(e);
  }
}

/** DELETE /api/vendor/offers/:code — past orders keep the discount they got. */
export async function DELETE(_request: Request, { params }: Params) {
  const ctx = await vendorWriteContext("vendor.promotions", "vendor-growth");
  if (ctx instanceof Response) return ctx;
  const code = normalizeCode(decodeURIComponent((await params).code));
  if (!/^[A-Z0-9]{4,24}$/.test(code)) return notFound();
  try {
    if (!(await owned(code, ctx.restaurant.id))) return notFound();
    await deletePromotion(code);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return vendorWriteError(e);
  }
}
