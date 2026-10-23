import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { readByIds } from "@/lib/data-access/scoped-riders";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyStaff } from "@/lib/notifications/ops-notify";
import { mapRpcError, type OpsResult } from "@/lib/ops/order-actions";
import { ALERT_KINDS, alertKindDef, effectiveRule, type OpsAlertKind } from "@/lib/ops/alerts/catalog";
import { loadAlertRules } from "@/lib/ops/alerts/engine";
import { addDays, istDayKey, istDayStart } from "@/lib/metrics";
import {
  ALERT_COLUMNS,
  alertVisible,
  encodeCursor,
  toAlert,
  visibleKinds,
  type Alert,
  type AlertQuery,
  type AlertRow,
  type AlertRule,
} from "@/lib/ops/alerts-contract";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

/**
 * Alerts and thresholds for the Manager app (§14). A manager sees the alerts of
 * their zones (and platform-wide incidents) that they could act on — the
 * finance, marketing and support kinds need their switch. Every action is its
 * audited RPC (0166).
 */

export interface Viewer {
  admin: boolean;
  permissions: Record<string, boolean>;
}

const MAX_CRITICAL = 100;
// The builder's generic is too deep to name; the filters only chain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function scoped(query: Chain, scope: ManagerScope, zone: string | null): Chain {
  const zones = scopeZoneIds(zone ? narrowScope(scope, zone) : scope);
  if (zones === null) return query;
  if (zones.length === 0) return query.eq("kind", "incident").is("zone_id", null);
  // The zone's alerts, and platform-wide incidents (never other platform-wide kinds).
  const inZones = `zone_id.in.(${(zones as string[]).join(",")})`;
  return zone ? query.in("zone_id", zones as string[]) : query.or(`${inZones},and(zone_id.is.null,kind.eq.incident)`);
}

async function staffNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const rows = await readByIds<{ id: string; full_name: string | null }>("profiles", "id, full_name", "id", ids.filter((x): x is string => !!x));
  return new Map(rows.map((r) => [r.id, r.full_name?.trim() || "Staff"]));
}

/** Open / acknowledged / critical counts for what a person can see, in one grouped query. */
export async function alertCounts(
  scope: ManagerScope,
  viewer: Viewer,
  opts: { zone?: string | null; kinds?: OpsAlertKind[] | null } = {}
): Promise<{ open: number; acknowledged: number; critical: number }> {
  const kinds = visibleKinds(viewer).filter((k) => !opts.kinds || opts.kinds.includes(k));
  if (kinds.length === 0) return { open: 0, acknowledged: 0, critical: 0 };
  const zones = scopeZoneIds(opts.zone ? narrowScope(scope, opts.zone) : scope);
  const { data, error } = await createAdminClient().rpc("ops_alert_counts", {
    p_zone_ids: zones === null ? [] : (zones as string[]),
    p_all: zones === null,
    p_kinds: kinds,
    // A single zone asked for: platform-wide incidents are not "in" it.
    p_incidents: !opts.zone,
  });
  if (error) throw error;
  const c = (data ?? {}) as { open?: number; acknowledged?: number; critical?: number };
  return { open: Number(c.open ?? 0), acknowledged: Number(c.acknowledged ?? 0), critical: Number(c.critical ?? 0) };
}

export async function listAlerts(
  scope: ManagerScope,
  viewer: Viewer,
  q: AlertQuery,
  now: Date
): Promise<{ items: Alert[]; nextCursor: string | null; counts: { open: number; acknowledged: number; critical: number } }> {
  const db = createAdminClient();
  const kinds = visibleKinds(viewer).filter((k) => !q.kinds || q.kinds.includes(k));
  const empty = { items: [], nextCursor: null, counts: { open: 0, acknowledged: 0, critical: 0 } };
  if (kinds.length === 0) return empty;

  const from = q.from ?? (q.statuses.includes("resolved") ? addDays(istDayKey(now), -6) : null);
  const base = () => {
    let query = scoped(db.from("ops_alerts").select(ALERT_COLUMNS), scope, q.zone).in("kind", kinds).in("status", q.statuses);
    if (q.severities) query = query.in("severity", q.severities);
    if (from) query = query.gte("opened_at", istDayStart(from).toISOString());
    if (q.to) query = query.lt("opened_at", istDayStart(addDays(q.to, 1)).toISOString());
    return query;
  };

  // Critical first (on the first page), then newest. Paged on (opened_at, id):
  // an alert's opened_at never changes, so a page boundary cannot move under
  // the reader the way last_seen_at did on every sweep.
  let critical: AlertRow[] = [];
  if (!q.cursor && (!q.severities || q.severities.includes("critical"))) {
    const { data, error } = await base().eq("severity", "critical").order("opened_at", { ascending: false }).order("id").limit(MAX_CRITICAL);
    if (error) throw error;
    critical = (data ?? []) as AlertRow[];
  }
  let rest = base().neq("severity", "critical");
  if (q.cursor) rest = rest.or(`opened_at.lt.${q.cursor.at},and(opened_at.eq.${q.cursor.at},id.gt.${q.cursor.id})`);
  const { data, error } = await rest.order("opened_at", { ascending: false }).order("id").limit(q.limit + 1);
  if (error) throw error;
  const page = (data ?? []) as AlertRow[];
  const more = page.length > q.limit;
  const normal = page.slice(0, q.limit);
  const rows = [...critical, ...normal].filter((r) => alertVisible({ kind: r.kind, zoneId: r.zone_id }, viewer));

  const [names, counts] = await Promise.all([
    staffNames(rows.flatMap((r) => [r.acknowledged_by, r.resolved_by])),
    alertCounts(scope, viewer, { zone: q.zone, kinds: q.kinds }),
  ]);
  const last = normal[normal.length - 1];
  return {
    items: rows.map((r) => toAlert(r, names)),
    nextCursor: more && last ? encodeCursor({ at: last.opened_at, id: last.id }) : null,
    counts,
  };
}

async function scopedAlert(scope: ManagerScope, viewer: Viewer, id: string): Promise<AlertRow | null> {
  const { data, error } = await scoped(createAdminClient().from("ops_alerts").select(ALERT_COLUMNS).eq("id", id), scope, null).maybeSingle();
  if (error) throw error;
  const row = (data as AlertRow | null) ?? null;
  return row && alertVisible({ kind: row.kind, zoneId: row.zone_id }, viewer) ? row : null;
}

export async function getAlert(scope: ManagerScope, viewer: Viewer, id: string) {
  const row = await scopedAlert(scope, viewer, id);
  if (!row) return null;
  const { data, error } = await createAdminClient()
    .from("ops_alert_events").select("event, actor_id, note, created_at").eq("alert_id", id).order("created_at").limit(200);
  if (error) throw error;
  const events = (data ?? []) as { event: string; actor_id: string | null; note: string | null; created_at: string }[];
  const names = await staffNames([row.acknowledged_by, row.resolved_by, ...events.map((e) => e.actor_id)]);
  return {
    alert: toAlert(row, names),
    history: events.map((e) => ({
      at: e.created_at, event: e.event, note: e.note,
      actor: e.actor_id ? { id: e.actor_id, name: names.get(e.actor_id) ?? "Staff" } : null,
    })),
  };
}

function mapAlertError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const m = (e.message ?? "").trim();
  if (m === "already_resolved") return { ok: false, status: 409, error: "already_resolved" };
  if (m === "bad_threshold") return { ok: false, status: 400, error: "bad_threshold" };
  if (m === "bad_kind" || m === "bad_request") return { ok: false, status: 400, error: "bad_request" };
  return mapRpcError(e);
}

export async function alertAction(
  actor: OpsActor,
  scope: ManagerScope,
  viewer: Viewer,
  id: string,
  action: "acknowledge" | "resolve",
  note: string | null,
  clientActionId: string
): Promise<OpsResult & { alert?: Alert }> {
  if (!(await scopedAlert(scope, viewer, id))) return { ok: false, status: 404, error: "not_found" };
  const { error } = action === "acknowledge"
    ? await createAdminClient().rpc("ops_ack_alert", { p_actor: actor.id, p_alert: id, p_client_action_id: clientActionId })
    : await createAdminClient().rpc("ops_resolve_alert", { p_actor: actor.id, p_alert: id, p_note: note, p_client_action_id: clientActionId });
  if (error) return mapAlertError(error);
  const fresh = await getAlert(scope, viewer, id);
  return { ok: true, alert: fresh?.alert };
}

export async function raiseIncident(
  actor: OpsActor,
  scope: ManagerScope,
  viewer: Viewer,
  input: { title: string; body: string; severity: "warning" | "critical"; zoneId: string; clientActionId: string }
): Promise<OpsResult & { alert?: Alert }> {
  const zones = scopeZoneIds(scope);
  if (zones !== null && !zones.includes(input.zoneId)) return { ok: false, status: 404, error: "not_found" };
  const { data, error } = await createAdminClient().rpc("ops_raise_incident", {
    p_actor: actor.id, p_zone: input.zoneId, p_title: input.title, p_body: input.body, p_severity: input.severity,
    p_client_action_id: input.clientActionId,
  });
  if (error) return mapAlertError(error);
  const id = String(data);
  // Incidents always push, whatever anyone's switches.
  deferNotify(async () => {
    await notifyStaff(
      { zoneId: input.zoneId, kind: "incident", severity: input.severity, force: true },
      { title: `Incident: ${input.title}`, body: input.body },
      { url: `/alerts/${id}`, alertId: id }
    );
    await createAdminClient().rpc("ops_mark_alert_pushed", { p_id: id });
  });
  const fresh = await getAlert(scope, viewer, id);
  return { ok: true, alert: fresh?.alert };
}

// ── thresholds ─────────────────────────────────────────────────────────────

type RuleRow = { kind: string; zone_id: string | null; enabled: boolean; threshold: number | string | null; window_minutes: number | null; updated_by: string | null; updated_at: string | null };

export async function listRules(zone: string | null): Promise<AlertRule[]> {
  const { data, error } = await createAdminClient()
    .from("ops_alert_rules").select("kind, zone_id, enabled, threshold, window_minutes, updated_by, updated_at");
  if (error) throw error;
  const rows = (data ?? []) as RuleRow[];
  const names = await staffNames(rows.map((r) => r.updated_by));
  const resolved = rows.map((r) => ({
    kind: r.kind as OpsAlertKind, zoneId: r.zone_id, enabled: r.enabled,
    threshold: r.threshold === null ? null : Number(r.threshold), windowMinutes: r.window_minutes,
  }));
  return ALERT_KINDS.map((def) => {
    const own = zone ? rows.find((r) => r.kind === def.kind && r.zone_id === zone) : rows.find((r) => r.kind === def.kind && r.zone_id === null);
    const rule = effectiveRule(resolved, def.kind, zone);
    const source = own ?? rows.find((r) => r.kind === def.kind && r.zone_id === null) ?? null;
    return {
      kind: def.kind,
      zoneId: zone,
      inherited: zone !== null && !own,
      enabled: rule.enabled,
      threshold: rule.threshold,
      unit: def.unit,
      windowMinutes: rule.windowMinutes,
      updatedBy: source?.updated_by ? { id: source.updated_by, name: names.get(source.updated_by) ?? "Staff" } : null,
      updatedAt: source?.updated_at ?? null,
      label: def.label,
      description: def.description,
    };
  });
}

export async function setRule(
  actor: OpsActor,
  v: { kind: OpsAlertKind; zoneId: string | null; enabled: boolean; threshold: number | null; windowMinutes: number | null; clientActionId: string }
): Promise<OpsResult & { rule?: AlertRule }> {
  if (v.zoneId === null && actor.role !== "admin") return { ok: false, status: 403, error: "permission_denied" };
  const { error } = await createAdminClient().rpc("ops_set_alert_rule", {
    p_actor: actor.id, p_kind: v.kind, p_zone: v.zoneId, p_enabled: v.enabled, p_threshold: v.threshold, p_window: v.windowMinutes,
    p_client_action_id: v.clientActionId,
  });
  if (error) return mapAlertError(error);
  const rule = (await listRules(v.zoneId)).find((r) => r.kind === v.kind);
  return { ok: true, rule };
}

export async function resetRule(actor: OpsActor, kind: OpsAlertKind, zoneId: string, clientActionId: string): Promise<OpsResult & { rule?: AlertRule }> {
  const { error } = await createAdminClient().rpc("ops_reset_alert_rule", {
    p_actor: actor.id, p_kind: kind, p_zone: zoneId, p_client_action_id: clientActionId,
  });
  if (error) return mapAlertError(error);
  const rule = (await listRules(zoneId)).find((r) => r.kind === kind);
  return { ok: true, rule };
}

/** Kinds with a threshold the engine reads; the admin page shows the others as on/off only. */
export function hasThreshold(kind: OpsAlertKind): boolean {
  return alertKindDef(kind).unit !== "none";
}

/** Rules in force for a kind in a zone, for the engine's callers that need one (re-exported for routes). */
export { loadAlertRules };
