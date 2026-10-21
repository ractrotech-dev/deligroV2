import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { decideCashDeposit } from "@/lib/data-access/manager-cash";
import { parseDepositDecision } from "@/lib/ops/payment-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/cash/deposits/[id]/decide — confirm a rider's deposit
 * (writes the rider → manager cash handover, 0047's one ledger) or dispute it
 * with a note the rider reads (§5.14). One RPC with its audit row (0152).
 * Needs manager.cash. 60 writes a minute.
 *
 * → 200 { deposit: CashDeposit }   → 400 note_required | bad_request   → 404 not_found   → 409 already_decided
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.cash");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "cash-writes");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseDepositDecision(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });

  try {
    const result = await decideCashDeposit(ctx, id.toLowerCase(), parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ deposit: result.value });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
