import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getCustomer, setCustomerAccount } from "@/lib/data-access/manager-customers";
import { parseAccountActionBody } from "@/lib/ops/customer-contract";
import { actionFailed, actorOf, badField, failure, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * POST …/customers/[id]/actions — suspend, restrict or reactivate a customer
 * with a reason (§10.8). Needs manager.customers.suspend (off by default).
 * 409 stale / not_a_customer; 502 effect_failed when the status is saved but
 * the sign-in ban could not be applied (retry with the same clientActionId).
 * 10 a minute per manager.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.customers.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.permissions["manager.customers.suspend"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.customers.suspend" }, { status: 403 });
  }
  const limited = await managerWriteLimit(ctx, "customer-actions", 10);
  if (limited) return limited;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const id = raw.toLowerCase();
  const parsed = parseAccountActionBody(await readJsonObject(request));
  if (!parsed.ok) return badField(parsed.field, parsed.error);
  let r;
  try {
    r = await setCustomerAccount(actorOf(ctx.profile), ctx.scope, id, parsed);
  } catch {
    return actionFailed();
  }
  if (!r.ok) return failure(r);
  const customer = await getCustomer(ctx.scope, id, ctx.permissions).catch(() => null);
  return NextResponse.json({ customer });
}
