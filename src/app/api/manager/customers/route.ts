import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit } from "@/lib/auth/manager-api.server";
import { listCustomers, searchCustomersByPhone } from "@/lib/data-access/manager-customers";
import { parseCustomerQuery } from "@/lib/ops/customer-contract";
import { actorOf, badField, loadFailed } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/customers — customers with an order in the manager's zones
 * (§10.1–10.2): q = a customer id, an 8+ hex prefix of it, or a name
 * fragment; status; zone; sort recent|orders|spend; keyset-paged.
 * `phone=` needs manager.customers.contact as well, and every such search is
 * audited (last four digits only). Payloads carry a masked phone only.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.customers.view");
  if (ctx instanceof Response) return ctx;
  const parsed = parseCustomerQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return badField(parsed.field);
  try {
    if (parsed.q.phone) {
      if (ctx.permissions["manager.customers.contact"] !== true) {
        return NextResponse.json({ error: "permission_denied", permission: "manager.customers.contact" }, { status: 403 });
      }
      const limited = await managerWriteLimit(ctx, "customer-contact", 10);
      if (limited) return limited;
      return NextResponse.json(await searchCustomersByPhone(actorOf(ctx.profile), ctx.scope, parsed.q, parsed.q.phone, randomUUID()));
    }
    return NextResponse.json(await listCustomers(ctx.scope, parsed.q));
  } catch {
    return loadFailed();
  }
}
