import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsTicketMessage } from "@/lib/data-access/manager-tickets";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseTicketMessageBody } from "@/lib/ops/vendor-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/tickets/[id]/messages — reply to the requester, or leave
 * an internal note they never see. Body { body: 1–4000, internal, clientActionId }.
 * The first public staff reply sets first_response_at and moves an open ticket
 * to in_progress (0145); the requester is pushed for public replies only.
 *
 * → 201 { ok: true }   → 400 bad_request | reason_required   → 404 not_found
 * → 409 invalid_transition (closed)   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "ticket-messages");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = parseTicketMessageBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const m = parsed.message;
    const result = await opsTicketMessage(actor, ctx.scope, id.toLowerCase(), m.body, m.internal, m.clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
