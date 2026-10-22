import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid, scopeZoneIds } from "@/lib/auth/manager-scope";
import { listRules, resetRule, setRule } from "@/lib/data-access/manager-alerts";
import { parseRuleBody } from "@/lib/ops/alerts-contract";
import { isOpsAlertKind } from "@/lib/ops-alerts/kinds";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export const dynamic = "force-dynamic";

const actorOf = (role: string, id: string): OpsActor => ({ id, role: role === "admin" ? "admin" : "manager" });

/**
 * Alert thresholds (§14 "configurable thresholds").
 *
 * GET ?zone= → { rules: [AlertRule] } — one per kind: the zone's own rule, or
 *   the platform default it inherits (`inherited: true`). Every manager reads.
 * PUT { kind, zoneId, enabled, threshold, windowMinutes, clientActionId } →
 *   { rule } — `manager.alerts.configure`; a zone of theirs; the platform
 *   default (zoneId null) is admin-only (403 permission_denied). Bounds per
 *   unit: minutes 1–1440, percent 1–100, ratio 0.5–20, rupees 50–100000,
 *   window 5–10080 (400 bad_threshold).
 * DELETE ?kind&zone&clientActionId (zone required) → { rule } — back to the
 *   inherited default.
 * Writes are audited (alert_rule.set / alert_rule.reset).
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext();
  if (ctx instanceof Response) return ctx;
  const zone = new URL(request.url).searchParams.get("zone");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });
  const zones = scopeZoneIds(ctx.scope);
  if (zone && zones !== null && !zones.includes(zone.toLowerCase())) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return NextResponse.json({ rules: await listRules(zone ? zone.toLowerCase() : null) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const ctx = await managerApiContext("manager.alerts.configure");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "alert-rules", 30);
  if (limited) return limited;
  const parsed = parseRuleBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  const zones = scopeZoneIds(ctx.scope);
  if (parsed.value.zoneId && zones !== null && !zones.includes(parsed.value.zoneId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const r = await setRule(actorOf(ctx.profile.role, ctx.profile.id), parsed.value);
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.extra ?? {}) }, { status: r.status });
    return NextResponse.json({ rule: r.rule ?? null });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const ctx = await managerApiContext("manager.alerts.configure");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "alert-rules", 30);
  if (limited) return limited;
  const sp = new URL(request.url).searchParams;
  const kind = sp.get("kind");
  const zone = sp.get("zone");
  const cid = sp.get("clientActionId");
  if (!isOpsAlertKind(kind)) return NextResponse.json({ error: "bad_request", field: "kind" }, { status: 400 });
  if (!zone || !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });
  if (!cid || !isUuid(cid)) return NextResponse.json({ error: "bad_request", field: "clientActionId" }, { status: 400 });
  const zones = scopeZoneIds(ctx.scope);
  if (zones !== null && !zones.includes(zone.toLowerCase())) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const r = await resetRule(actorOf(ctx.profile.role, ctx.profile.id), kind, zone.toLowerCase(), cid);
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.extra ?? {}) }, { status: r.status });
    return NextResponse.json({ rule: r.rule ?? null });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
