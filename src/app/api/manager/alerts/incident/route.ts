import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { raiseIncident } from "@/lib/data-access/manager-alerts";
import { parseIncident } from "@/lib/ops/alerts-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/alerts/incident — a manager raises an operational incident
 * in one of their zones (§14.13): it opens an `incident` alert, is audited,
 * and pushes every admin and the zone's managers whatever their switches.
 *
 * Body { title: 3–120, body: 3–1000, severity: warning | critical, zoneId, clientActionId }
 * → 201 { alert }   → 400 bad_request   → 404 not_found (zone not theirs)   → 409 stale   → 429
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "incident", 10);
  if (limited) return limited;
  const parsed = parseIncident(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  const actor: OpsActor = { id: ctx.profile.id, role: ctx.profile.role === "admin" ? "admin" : "manager" };
  try {
    const viewer = { admin: ctx.profile.role === "admin", permissions: ctx.permissions };
    const r = await raiseIncident(actor, ctx.scope, viewer, parsed.value);
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.extra ?? {}) }, { status: r.status });
    return NextResponse.json({ alert: r.alert ?? null }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
