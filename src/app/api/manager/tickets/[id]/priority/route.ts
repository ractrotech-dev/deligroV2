import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsTicketPriority } from "@/lib/data-access/manager-tickets";
import { parsePriorityBody } from "@/lib/ops/support-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/tickets/[id]/priority — change a ticket's priority with
 * a reason (audited, ops_set_ticket_priority). Raising it to high or
 * emergency opens the complaint alert for the zone at once.
 *
 * Body { priority: normal | high | emergency, reason: 3–300, clientActionId }
 * → 200 { ok: true }   → 400 bad_request | reason_required   → 404 not_found   → 409 invalid_transition | stale   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "ticket-priority");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parsePriorityBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const v = parsed.value;
    const result = await opsTicketPriority(actor, ctx.scope, id.toLowerCase(), v.priority, v.reason, v.clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
