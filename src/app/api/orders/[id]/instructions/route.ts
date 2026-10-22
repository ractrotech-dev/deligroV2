import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { captureError } from "@/lib/obs/emit";
import { updateOrderInstructions } from "@/lib/data-access/order-instructions";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { isUuid } from "@/lib/support/rules";

/**
 * PATCH /api/orders/[id]/instructions — the customer changes the delivery
 * instructions on their own order, any time before it is delivered.
 *
 *   { instructions: string | null }   ≤ 300 characters; blank clears it
 *
 *   200 { ok: true, instructions, riderTold }
 *       riderTold: a rider holds the order and was pushed the new text
 *       (`delivery_updates`) — the rider app highlights it.
 *   400 invalid_body | instructions_too_long | invalid_instructions
 *   401 unauthorized
 *   404 not_found      not the caller's order (same answer as no order)
 *   409 order_closed   delivered or cancelled
 *   429 · 503 migration_pending (0082's column) | backend_not_configured
 *
 * Ownership is checked in the data layer on the service-role client, after
 * the session check here. Rate limit: 10 a minute per customer.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = await rateLimit(`order-instructions:${user.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let instructions: unknown;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || !("instructions" in body)) throw new Error("shape");
    instructions = (body as { instructions: unknown }).instructions;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await updateOrderInstructions(user.id, id, instructions);
    if (result.ok) return NextResponse.json(result);
    const status = result.error === "not_found" ? 404 : result.error === "order_closed" ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  } catch (e) {
    if (isRiderSchemaPending(e)) return NextResponse.json({ error: "migration_pending" }, { status: 503 });
    captureError(e, { source: "/api/orders/[id]/instructions", httpMethod: "PATCH", attrs: { event: "instructions_update_failed" } });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
