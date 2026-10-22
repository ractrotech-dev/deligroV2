import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { alertAction } from "@/lib/data-access/manager-alerts";
import { parseAlertAction } from "@/lib/ops/alerts-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/alerts/[id]/actions — acknowledge, or resolve with a note
 * (3–300). Audited in the same transaction (ops_ack_alert / ops_resolve_alert).
 * An acknowledged alert still clears itself when its condition goes.
 *
 * Body { action: acknowledge | resolve, note?, clientActionId }
 * → 200 { alert }   → 400 bad_request | reason_required   → 404 not_found   → 409 already_resolved | stale   → 429
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "alert-actions");
  if (limited) return limited;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseAlertAction(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const viewer = { admin: ctx.profile.role === "admin", permissions: ctx.permissions };
    const v = parsed.value;
    const r = await alertAction(actor, ctx.scope, viewer, id.toLowerCase(), v.action, v.note, v.clientActionId);
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.extra ?? {}) }, { status: r.status });
    return NextResponse.json({ alert: r.alert ?? null });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
