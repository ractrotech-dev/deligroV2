import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { narrowScope } from "@/lib/auth/manager-scope";
import { listManagerOrders } from "@/lib/data-access/manager-ops-orders";
import { customerVisible } from "@/lib/data-access/manager-customers";
import { parseOrderQuery } from "@/lib/ops/order-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/orders — every order in the manager's zones (§3.1–3.7,
 * §3.12–3.13), newest first, keyset-paged.
 *
 * Query: q (uuid, 4–8 character code prefix, customer or shop name, or a whole
 * phone number), from, to (ISO; to exclusive), vendor, rider, customer, status
 * (db statuses or pending/completed/today), payment (cod, online, pending, paid,
 * failed, refunded), zone, queue (delayed|unassigned|cancelled), cursor, limit
 * (1–100, default 50).
 *
 * Names are already on these rows, so a name search needs nothing more. A phone
 * is masked on them, so a phone search needs manager.customers.view and
 * manager.customers.contact, is rate-limited and is audited (last four digits
 * only), exactly as GET /api/manager/customers?phone= is.
 *
 * → 200 { items: OrderListItem[], nextCursor, counts: { delayed, unassigned } }
 * → 400 { error: "bad_request", field }   → 403 permission_denied (phone search)
 * → 429   → 500 { error: "load_failed" }
 * Contract: docs/superpowers/plans/2026-10-21-manager-app-phase-3-orders-live.md.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.orders.view");
  if (ctx instanceof Response) return ctx;

  const now = new Date();
  const parsed = parseOrderQuery(new URL(request.url).searchParams, now);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  if (parsed.query.q?.kind === "phone") {
    for (const permission of ["manager.customers.view", "manager.customers.contact"]) {
      if (ctx.permissions[permission] !== true) {
        return NextResponse.json({ error: "permission_denied", permission }, { status: 403 });
      }
    }
    const limited = await managerWriteLimit(ctx, "customer-contact", 10);
    if (limited) return limited;
  }

  try {
    // Phase 7: one customer's orders — a customer outside the zones is not found.
    if (parsed.query.customer && !(await customerVisible(ctx.scope, parsed.query.customer))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const result = await listManagerOrders(narrowScope(ctx.scope, parsed.query.zone), parsed.query, { now, actorId: ctx.profile.id });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
