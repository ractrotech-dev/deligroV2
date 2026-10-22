import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { customerVisible, decodeKeyCursor, listCustomerComplaints } from "@/lib/data-access/manager-customers";
import { badField, loadFailed, notFound } from "@/lib/ops/route-answers";

export const dynamic = "force-dynamic";

/** GET …/customers/[id]/complaints — tickets this customer raised, in scope (§10.4). */
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
    return NextResponse.json(await listCustomerComplaints(ctx.scope, id, cursor));
  } catch {
    return loadFailed();
  }
}
