import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsTicketStatus } from "@/lib/data-access/manager-tickets";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseTicketStatusBody } from "@/lib/ops/vendor-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/tickets/[id]/status — move a ticket to in_progress,
 * waiting_on_requester, resolved or closed. Resolved and closed need a
 * 3–1000 character resolution; closed is final.
 *
 * → 200 { ok: true }   → 400 bad_request | reason_required   → 404 not_found
 * → 409 invalid_transition   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "ticket-status");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = parseTicketStatusBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const s = parsed.status;
    const result = await opsTicketStatus(actor, ctx.scope, id.toLowerCase(), s.status, s.resolution, s.clientActionId);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
