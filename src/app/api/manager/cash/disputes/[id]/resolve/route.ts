import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { resolveCashDispute } from "@/lib/data-access/manager-cash";
import { parseDisputeResolution } from "@/lib/ops/payment-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/cash/disputes/[id]/resolve — close a rider's cash dispute
 * with what was found (3–500 characters). One RPC with its audit row (0152).
 * Needs manager.cash. 60 writes a minute.
 *
 * → 200 { dispute: CashDispute }   → 400 bad_request   → 404 not_found   → 409 already_resolved
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.cash");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "cash-writes");
  if (limited) return limited;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseDisputeResolution(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });
  try {
    const result = await resolveCashDispute(ctx, id.toLowerCase(), parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ dispute: result.value });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
