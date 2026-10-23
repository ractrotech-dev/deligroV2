import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { customerVisible, decodeKeyCursor } from "@/lib/data-access/manager-customers";
import { listRefundsFor } from "@/lib/data-access/manager-finance";
import { badField, loadFailed, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/**
 * GET …/customers/[id]/refunds — this customer's refund requests, in scope
 * (§10.5), in Phase 6's RefundItem shape. Viewing needs only
 * customers.view; deciding is Phase 6's route (finance.view + finance.adjust).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.customers.view");
  if (ctx instanceof Response) return ctx;
  const { id: raw } = await params;
  if (!isUuid(raw)) return notFound();
  const id = raw.toLowerCase();
  const rawCursor = new URL(request.url).searchParams.get("cursor");
  const cursor = decodeKeyCursor(rawCursor);
  if (rawCursor && !cursor) return badField("cursor");
  try {
    if (!(await customerVisible(ctx.scope, id))) return notFound();
    const page = await listRefundsFor(ctx.scope, { status: null, range: null, zone: null, cursor, customer: id });
    return NextResponse.json({ items: page.items, nextCursor: page.nextCursor });
  } catch {
    return loadFailed();
  }
}
