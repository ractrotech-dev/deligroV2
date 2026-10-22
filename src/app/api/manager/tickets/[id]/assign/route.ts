import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsAssignTicket } from "@/lib/data-access/manager-tickets";
import { parseAssignBody } from "@/lib/ops/support-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/tickets/[id]/assign — give the ticket to an admin or a
 * manager of its zone with support access, and/or a team (§11.3); `assigneeId:
 * null` unassigns. Audited in the same transaction (ops_assign_ticket); the
 * assignee is pushed.
 *
 * Body { assigneeId: uuid | null, team: operations | finance | vendor_support | rider_support | customer_support | null, clientActionId }
 * → 200 { ok: true }   → 400 bad_request   → 404 not_found   → 409 assignee_ineligible | invalid_transition | stale   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "ticket-assign");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseAssignBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const v = parsed.value;
    const result = await opsAssignTicket(actor, ctx.scope, id.toLowerCase(), v.assigneeId, v.team, v.clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
