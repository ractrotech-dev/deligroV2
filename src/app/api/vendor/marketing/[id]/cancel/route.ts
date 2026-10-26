import { NextResponse } from "next/server";
import { vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { cancelMarketingRequest } from "@/lib/data-access/marketing";
import { isUuid } from "@/lib/vendor/uuid";

/** POST /api/vendor/marketing/:id/cancel — withdraw a request Deligro hasn't acted on yet. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorWriteContext("vendor.marketing", "vendor-growth");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return (await cancelMarketingRequest(ctx.restaurant.id, ctx.profile.id, id))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "invalid_transition" }, { status: 409 });
  } catch (e) {
    return vendorWriteError(e);
  }
}
