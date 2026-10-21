import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getMyTicket, SupportNotMigratedError } from "@/lib/data-access/support";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isUuid } from "@/lib/vendor/uuid";

export const dynamic = "force-dynamic";

/** GET /api/vendor/support/:id — one of the caller's tickets with its thread (never internal notes). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-growth-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const t = await getMyTicket(ctx.profile.id, id);
    return t ? NextResponse.json(t) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    if (e instanceof SupportNotMigratedError) return NextResponse.json({ error: "needs_migration" }, { status: 409 });
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
