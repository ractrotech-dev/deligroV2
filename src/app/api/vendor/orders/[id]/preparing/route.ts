import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { startPreparing } from "@/lib/data-access/vendor-orders";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * POST /api/vendor/orders/:id/preparing — Accepted → Preparing (0061).
 * → 200 { preparingAt }; 409 `invalid_transition` when the order isn't an
 * accepted order of this shop's, or was already started. The database
 * function re-checks ownership; this route only gates and throttles.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  // Shares the status route's bucket: both are a kitchen moving orders by hand.
  const limit = await rateLimit(`order-status:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  try {
    const preparingAt = await startPreparing(id);
    return NextResponse.json({ ok: true, preparingAt });
  } catch (e) {
    if (e instanceof Error && e.message === "invalid_transition") {
      return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
