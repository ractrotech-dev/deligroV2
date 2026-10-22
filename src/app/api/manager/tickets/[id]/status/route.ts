import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { opsTicketStatus } from "@/lib/data-access/manager-tickets";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";
import { parseStatusBody } from "@/lib/ops/support-contract";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/tickets/[id]/status — move a ticket along the transition
 * table (0165): open / in_progress / waiting_on_requester / escalated →
 * … ; resolved needs a 3–1000 character resolution (closing reuses it);
 * reopening a resolved ticket needs a reason; closed is final.
 *
 * Body { status, resolution?, reason?, clientActionId }
 * → 200 { ok: true }   → 400 bad_request | reason_required   → 404 not_found
 * → 409 invalid_transition { allowed } | stale   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.support.manage");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "ticket-status");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = parseStatusBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const s = parsed.value;
    const result = await opsTicketStatus(actor, ctx.scope, id.toLowerCase(), s.status, s.resolution, s.clientActionId, s.reason);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
