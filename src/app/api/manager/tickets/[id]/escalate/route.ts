import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsEscalateTicket } from "@/lib/data-access/manager-tickets";
import { parseEscalateBody } from "@/lib/ops/support-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/tickets/[id]/escalate — raise the ticket one level (max 3)
 * with a reason; status becomes escalated (§11.8). Level 1 tells the zone's
 * support managers; level 2 and up tells every admin as well.
 *
 * Body { reason: 3–300, clientActionId }
 * → 200 { ok: true, level }   → 400 bad_request | reason_required   → 404 not_found
 * → 409 max_level | invalid_transition | stale   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "ticket-escalate");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseEscalateBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const result = await opsEscalateTicket(actor, ctx.scope, id.toLowerCase(), parsed.value.reason, parsed.value.clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true, level: result.level });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
