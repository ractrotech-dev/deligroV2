import { NextResponse } from "next/server";
import { badRequest, readJsonBody, vendorApiContext, vendorWriteContext, vendorWriteError } from "@/lib/auth/vendor-api.server";
import { createAppTicket, listMyAppTickets, SupportNotMigratedError } from "@/lib/data-access/support";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { parseTicket } from "@/lib/vendor/growth-input";

export const dynamic = "force-dynamic";

/** GET /api/vendor/support — the signed-in vendor's tickets, most recently active first. */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  const limit = await rateLimit(`vendor-growth-read:${ctx.profile.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    return NextResponse.json({ tickets: await listMyAppTickets(ctx.profile.id) });
  } catch (e) {
    if (e instanceof SupportNotMigratedError) return NextResponse.json({ error: "needs_migration" }, { status: 409 });
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/vendor/support — open a ticket: { category, subject, body,
 * orderId?, attachments?: [paths from /support/attachments] }. An order must
 * be one of the shop's. → 201 { ticket }.
 */
export async function POST(request: Request) {
  const ctx = await vendorWriteContext(null, "vendor-support");
  if (ctx instanceof Response) return ctx;

  const input = parseTicket(await readJsonBody(request), ctx.profile.id);
  if ("error" in input) return badRequest(input.error);
  try {
    if (input.orderId) {
      // The order has to be this shop's (RLS: the owner reads their orders).
      const supabase = await createClient();
      const { data } = await supabase.from("orders").select("id").eq("id", input.orderId).eq("restaurant_id", ctx.restaurant.id).maybeSingle();
      if (!data) return badRequest("invalid_order");
    }
    const ticket = await createAppTicket(ctx.profile.id, "vendor", input);
    if (!ticket) return badRequest("invalid_attachment");
    return NextResponse.json({ ticket }, { status: 201 });
  } catch (e) {
    if (e instanceof SupportNotMigratedError) return NextResponse.json({ error: "needs_migration" }, { status: 409 });
    return vendorWriteError(e);
  }
}
