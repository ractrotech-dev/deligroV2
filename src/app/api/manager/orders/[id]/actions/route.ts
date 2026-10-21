import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getManagerOrderDetail } from "@/lib/data-access/manager-ops-orders";
import {
  opsAdvance,
  opsAssign,
  opsCancel,
  opsCorrect,
  opsEscalate,
  opsNote,
  opsReassign,
  type OpsActor,
} from "@/lib/data-access/manager-ops-actions";
import { ACTION_PERMISSION, parseActionBody, type OpsResult } from "@/lib/ops/order-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/orders/[id]/actions — one intervention on one order
 * (§3.14–3.16, §6.9–6.10): advance, cancel, assign, reassign, escalate,
 * correct, note. Body and answers: the plan's API contract.
 *
 * Each action needs its own switch (ACTION_PERMISSION). The change and its
 * audit row are one RPC (0142/0143) that re-checks the zone in the database; a
 * replayed clientActionId answers 200 with the current order and changes
 * nothing. 60 writes a minute per manager.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "order-actions");
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const id = rawId.toLowerCase();

  const parsed = parseActionBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(
      parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error },
      { status: parsed.status }
    );
  }
  const a = parsed.action;
  const permission = ACTION_PERMISSION[a.action];
  if (ctx.permissions[permission] !== true) {
    return NextResponse.json({ error: "permission_denied", permission }, { status: 403 });
  }

  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  let result: OpsResult & { ticket?: { id: string; number: number } };
  try {
    switch (a.action) {
      case "advance": result = await opsAdvance(actor, id, a.expected, a.reason, a.clientActionId); break;
      case "cancel": result = await opsCancel(actor, id, a.reason, a.clientActionId); break;
      case "assign": result = await opsAssign(actor, id, a.riderId, a.reason, a.clientActionId, a.override); break;
      case "reassign": result = await opsReassign(actor, id, a.riderId, a.reason, a.afterPickup, a.clientActionId, a.override); break;
      case "escalate": result = await opsEscalate(actor, id, a.reason, a.priority, a.clientActionId); break;
      case "correct":
        result = await opsCorrect(actor, id, { kind: a.kind, toStatus: a.toStatus, itemId: a.itemId, note: a.note }, a.reason, a.clientActionId);
        break;
      case "note": result = await opsNote(actor, id, a.note, a.clientActionId); break;
    }
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
  }

  try {
    const order = await getManagerOrderDetail(ctx.scope, id, { permissions: ctx.permissions, now: new Date() });
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, order, ...(result.ticket ? { ticket: result.ticket } : {}) });
  } catch {
    // The action is done; only the re-read failed. Say so rather than 500 the change.
    return NextResponse.json({ ok: true, order: null, ...(result.ticket ? { ticket: result.ticket } : {}) });
  }
}
