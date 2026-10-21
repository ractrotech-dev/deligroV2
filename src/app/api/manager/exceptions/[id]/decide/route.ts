import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { decideException, getException } from "@/lib/data-access/delivery-exceptions";
import { parseExceptionDecision } from "@/lib/ops/exception-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/exceptions/[id]/decide — approve or reject a rider's
 * request (a note is required to reject), or acknowledge a report.
 *
 * The decision and its audit row are one RPC (0152) and are never lost. What an
 * approval means — fail the delivery and cancel the order (refund rules
 * unchanged), complete it without the code, release it and take the rider
 * offline — runs after; if that part fails the answer is 502 effect_failed and
 * sending the same request again (same clientActionId) finishes it once.
 * Needs manager.exceptions.decide. 60 writes a minute.
 *
 * → 200 { exception: DeliveryException }   → 400 note_required | bad_request
 * → 404 not_found   → 409 already_resolved | invalid_transition   → 502 effect_failed { exceptionId }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.exceptions.decide");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "exception-decisions");
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const id = rawId.toLowerCase();
  const parsed = parseExceptionDecision(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });

  try {
    if (!(await getException(ctx.scope, id, ctx.permissions))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const result = await decideException(
      { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" },
      id,
      parsed.input.decision,
      parsed.input.note ?? undefined,
      parsed.input.clientActionId
    );
    if (!result.ok) {
      if (result.error === "effect_failed") return NextResponse.json({ error: "effect_failed", exceptionId: id }, { status: 502 });
      if (result.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
      if (result.error === "note_required") return NextResponse.json({ error: "note_required" }, { status: 400 });
      return NextResponse.json({ error: result.error === "invalid_decision" ? "invalid_transition" : result.error }, { status: 409 });
    }
    return NextResponse.json({ exception: await getException(ctx.scope, id, ctx.permissions) });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
