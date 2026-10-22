import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyStaff } from "@/lib/notifications/ops-notify";
import { captureError } from "@/lib/obs/emit";
import { ALERT_KINDS, alertKindDef, effectiveRule, type OpsAlertKind, type ResolvedRule } from "./catalog";
import { evaluate, type DesiredAlert } from "./evaluate";
import { loadAlertFacts } from "./facts";

/**
 * The alert engine (Phase 8). `evaluateAlerts` runs from the dispatch sweep
 * (cron and the boards' throttled sweeps): one run at a time platform-wide
 * (`ops_claim_alert_run`), every sweep kind raised or kept, and cleared when
 * its condition is gone. `raiseEventAlert` is for the things that ARE the
 * alert (a failed delivery, a new marketing request, an urgent ticket, a cash
 * dispute): raised the moment they happen, the sweep then keeps or clears them.
 *
 * Pushes go through notifyStaff (zone + permission + mutes); each push
 * carries the alert id, and the app opens /alerts/<id>.
 */

const LEASE_SECONDS = 55;

type RuleRow = { kind: string; zone_id: string | null; enabled: boolean; threshold: number | string | null; window_minutes: number | null };

export async function loadAlertRules(): Promise<ResolvedRule[]> {
  const { data, error } = await createAdminClient()
    .from("ops_alert_rules")
    .select("kind, zone_id, enabled, threshold, window_minutes");
  if (error) throw error;
  return ((data ?? []) as RuleRow[]).map((r) => ({
    kind: r.kind as OpsAlertKind,
    zoneId: r.zone_id,
    enabled: r.enabled,
    threshold: r.threshold === null ? null : Number(r.threshold),
    windowMinutes: r.window_minutes,
  }));
}

/** Raise one alert; when the database says so, tell the staff it concerns. Answers people pushed. */
async function raiseAndNotify(a: DesiredAlert): Promise<{ raised: boolean; pushed: number }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("ops_raise_alert", {
    p_kind: a.kind,
    p_severity: a.severity,
    p_title: a.title,
    p_body: a.body,
    p_zone: a.zoneId,
    p_entity_type: a.entity.type,
    p_entity_id: a.entity.id,
    p_dedupe_key: a.dedupeKey,
  });
  if (error) throw error;
  const res = data as { id: string; push: boolean };
  if (!res?.push) return { raised: true, pushed: 0 };
  const sent = await notifyStaff(
    { zoneId: a.zoneId, kind: a.kind, permission: alertKindDef(a.kind).audiencePermission, severity: a.severity },
    { title: a.title, body: a.body },
    { url: `/alerts/${res.id}`, alertId: res.id }
  );
  await supabase.rpc("ops_mark_alert_pushed", { p_id: res.id });
  return { raised: true, pushed: sent.pushed };
}

/** Manager-raised incidents are not in any facts: never cleared by the sweep. */
async function openManualIncidentKeys(): Promise<string[]> {
  const { data } = await createAdminClient()
    .from("ops_alerts")
    .select("dedupe_key")
    .eq("kind", "incident")
    .neq("status", "resolved")
    .like("dedupe_key", "incident:manual:%");
  return ((data ?? []) as { dedupe_key: string }[]).map((r) => r.dedupe_key);
}

export async function evaluateAlerts(
  now: Date = new Date()
): Promise<{ raised: number; cleared: number; pushed: number } | { skipped: "lease" }> {
  const supabase = createAdminClient();
  const { data: won, error: leaseErr } = await supabase.rpc("ops_claim_alert_run", { p_name: "evaluate", p_seconds: LEASE_SECONDS });
  if (leaseErr) throw leaseErr;
  if (won !== true) return { skipped: "lease" };

  const rules = await loadAlertRules();
  const facts = await loadAlertFacts(now, rules);
  const desired = evaluate(facts, rules);

  let raised = 0;
  let cleared = 0;
  let pushed = 0;
  for (const def of ALERT_KINDS) {
    if (def.evaluated !== "sweep" && def.evaluated !== "both") continue;
    if (facts.unavailable.includes(def.kind)) continue;
    const list = desired.get(def.kind) ?? [];
    for (const a of list) {
      try {
        const r = await raiseAndNotify(a);
        if (r.raised) raised += 1;
        pushed += r.pushed;
      } catch (e) {
        captureError(e, { source: "alerts/raise", attrs: { kind: a.kind } });
      }
    }
    let keep = list.map((a) => a.dedupeKey);
    if (def.kind === "incident") keep = keep.concat(await openManualIncidentKeys());
    const { data, error } = await supabase.rpc("ops_clear_alerts", { p_kind: def.kind, p_keep_keys: keep });
    if (error) captureError(error, { source: "alerts/clear", attrs: { kind: def.kind } });
    else cleared += Number(data) || 0;
  }
  return { raised, cleared, pushed };
}

/**
 * Raise an event-shaped alert now. Honours the zone's rule (a switched-off
 * kind raises nothing). Never throws: an alert must not break the action that
 * caused it.
 */
export async function raiseEventAlert(a: DesiredAlert | null): Promise<void> {
  if (!a) return;
  try {
    const rule = effectiveRule(await loadAlertRules(), a.kind, a.zoneId);
    if (!rule.enabled) return;
    await raiseAndNotify(a);
  } catch (e) {
    captureError(e, { source: "alerts/event", attrs: { kind: a.kind } });
  }
}
