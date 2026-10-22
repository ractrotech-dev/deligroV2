import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getCustomer } from "@/lib/data-access/manager-customers";
import { loadFailed, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/** GET /api/manager/customers/[id] — one customer in scope (§10.1, §10.3–10.7). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.customers.view");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  try {
    const customer = await getCustomer(ctx.scope, id.toLowerCase(), ctx.permissions);
    return customer ? NextResponse.json({ customer }) : notFound();
  } catch {
    return loadFailed();
  }
}
