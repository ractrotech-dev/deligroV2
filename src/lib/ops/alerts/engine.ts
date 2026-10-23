import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createStaffDirectory, notifyStaff, type StaffDirectory } from "@/lib/notifications/ops-notify";
import { captureError } from "@/lib/obs/emit";
import { ALERT_KINDS, alertKindDef, effectiveRule, type OpsAlertKind, type ResolvedRule } from "./catalog";
import { alertData, evaluate, type DesiredAlert } from "./evaluate";
import { loadAlertFacts, type LoadedFacts } from "./facts";

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
 *
 * How a run treats the database (review #3, #5, #8, #21):
 *   * Raises go in batches (`ops_raise_alerts`, 200 a call), not one RPC each.
 *   * The staff directory is read once and shared by every notification.
 *   * A clear carries the moment the run began: an alert raised or refreshed
 *     after it — an event alert raised mid-run — is never cleared by older facts.
 *   * Kinds whose facts could not be read are left alone (neither raised nor
 *     cleared); kinds whose facts were cut short are raised but not cleared.
 *   * A failed delivery and a cash gap keep unacknowledged alerts open.
 *   * A run has a time budget under its lease: kinds it has no time for are
 *     deferred to the next run, never half-cleared. The lease is handed back.
 */

const LEASE_SECONDS = 120;
/** Under the lease, so a slow run stops itself instead of overlapping the next. */
const RUN_BUDGET_MS = 90_000;
/** The run's start is taken a little early: the database stamps alerts with its own clock. */
const RUN_CLOCK_SKEW_MS = 5_000;
const RAISE_CHUNK = 200;
const NOTIFY_CONCURRENCY = 4;
const PRUNE_EVERY_SECONDS = 86_400;
const KEEP_DAYS = 180;

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

/** What the engine needs from the world, so a run can be tested without one. */
export interface EngineDeps {
  db: { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> };
  loadRules: () => Promise<ResolvedRule[]>;
  loadFacts: (now: Date, rules: readonly ResolvedRule[], claim: (name: string, seconds: number) => Promise<boolean>) => Promise<LoadedFacts>;
  notify: typeof notifyStaff;
  directory: () => StaffDirectory;
  clock: () => number;
  capture: (e: unknown, ctx: { source: string; attrs?: Record<string, unknown> }) => void;
}

function defaultDeps(): EngineDeps {
  return {
    db: createAdminClient() as unknown as EngineDeps["db"],
    loadRules: loadAlertRules,
    loadFacts: (now, rules, claim) => loadAlertFacts(now, rules, { claim }),
    notify: notifyStaff,
    directory: () => createStaffDirectory(),
    clock: () => Date.now(),
    capture: (e, ctx) => captureError(e, ctx),
  };
}

type Raised = { dedupeKey: string; id?: string; push?: boolean; error?: string };

const chunks = <T,>(list: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

/** Runs `fn` over `items`, at most `n` at a time. */
async function inParallel<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        await fn(items[i]);
      }
    })
  );
}

export async function evaluateAlerts(
  now: Date = new Date(),
  deps: EngineDeps = defaultDeps()
): Promise<{ raised: number; cleared: number; pushed: number; deferred: OpsAlertKind[] } | { skipped: "lease" }> {
  const { db } = deps;
  const started = deps.clock();
  const claim = async (name: string, seconds: number): Promise<boolean> => {
    const { data, error } = await db.rpc("ops_claim_alert_run", { p_name: name, p_seconds: seconds });
    if (error) throw error;
    return data === true;
  };
  if (!(await claim("evaluate", LEASE_SECONDS))) return { skipped: "lease" };

  try {
    // Taken before any fact is read: whatever is raised after this is newer than the facts.
    const runStart = new Date(started - RUN_CLOCK_SKEW_MS).toISOString();
    const rules = await deps.loadRules();
    const facts = await deps.loadFacts(now, rules, claim);
    const desired = evaluate(facts, rules);
    const directory = deps.directory();

    let raised = 0;
    let cleared = 0;
    let pushed = 0;
    const deferred: OpsAlertKind[] = [];

    /** Raise a kind's alerts in batches; tell the staff each one concerns. Answers the ids pushed. */
    const raiseKind = async (list: DesiredAlert[]): Promise<string[]> => {
      const pushedIds: string[] = [];
      for (const batch of chunks(list, RAISE_CHUNK)) {
        const { data, error } = await db.rpc("ops_raise_alerts", {
          p_items: batch.map((a) => ({
            kind: a.kind, severity: a.severity, title: a.title, body: a.body, zone: a.zoneId,
            entityType: a.entity.type, entityId: a.entity.id, dedupeKey: a.dedupeKey,
          })),
        });
        if (error) {
          deps.capture(error, { source: "alerts/raise", attrs: { kind: batch[0]?.kind, items: batch.length } });
          continue;
        }
        const results = (Array.isArray(data) ? data : []) as Raised[];
        const byKey = new Map(batch.map((a) => [a.dedupeKey, a]));
        const toTell: { alert: DesiredAlert; id: string }[] = [];
        for (const r of results) {
          const alert = byKey.get(r.dedupeKey);
          if (!alert) continue;
          if (r.error || !r.id) {
            deps.capture(new Error(r.error ?? "raise failed"), { source: "alerts/raise", attrs: { kind: alert.kind } });
            continue;
          }
          raised += 1;
          if (r.push) toTell.push({ alert, id: r.id });
        }
        await inParallel(toTell, NOTIFY_CONCURRENCY, async ({ alert, id }) => {
          try {
            const sent = await deps.notify(
              { zoneId: alert.zoneId, kind: alert.kind, permission: alertKindDef(alert.kind).audiencePermission, severity: alert.severity },
              { title: alert.title, body: alert.body },
              { ...alertData(alert), url: `/alerts/${id}`, alertId: id },
              { directory }
            );
            pushed += sent.pushed;
          } catch (e) {
            deps.capture(e, { source: "alerts/notify", attrs: { kind: alert.kind } });
          }
          pushedIds.push(id);
        });
      }
      return pushedIds;
    };

    const allPushed: string[] = [];
    for (const def of ALERT_KINDS) {
      if (def.evaluated !== "sweep" && def.evaluated !== "both") continue;
      // Facts we could not read: say nothing, clear nothing.
      if (facts.unavailable.includes(def.kind)) continue;
      // Out of time: the next run picks this kind up; nothing is half done.
      if (deps.clock() - started > RUN_BUDGET_MS) {
        deferred.push(def.kind);
        continue;
      }
      const list = desired.get(def.kind) ?? [];
      allPushed.push(...(await raiseKind(list)));
      // Facts cut short (a capped read) prove nothing about what is missing.
      if (facts.partial.includes(def.kind)) continue;
      const { data, error } = await db.rpc("ops_clear_alerts", {
        p_kind: def.kind,
        p_keep_keys: list.map((a) => a.dedupeKey),
        p_run_start: runStart,
        p_keep_unacknowledged: def.sticky === true,
      });
      if (error) deps.capture(error, { source: "alerts/clear", attrs: { kind: def.kind } });
      else cleared += Number(data) || 0;
    }

    if (allPushed.length > 0) {
      const { error } = await db.rpc("ops_mark_alerts_pushed", { p_ids: allPushed });
      if (error) deps.capture(error, { source: "alerts/mark_pushed", attrs: { count: allPushed.length } });
    }

    // Once a day, old resolved alerts are dropped.
    try {
      if (await claim("prune", PRUNE_EVERY_SECONDS)) {
        const { error } = await db.rpc("ops_prune_alerts", { p_days: KEEP_DAYS });
        if (error) deps.capture(error, { source: "alerts/prune" });
      }
    } catch (e) {
      deps.capture(e, { source: "alerts/prune" });
    }
    return { raised, cleared, pushed, deferred };
  } finally {
    // Hand the lease back so the next sweep need not wait it out.
    try {
      await db.rpc("ops_release_alert_run", { p_name: "evaluate" });
    } catch (e) {
      deps.capture(e, { source: "alerts/release" });
    }
  }
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
    if (!res?.push) return;
    await notifyStaff(
      { zoneId: a.zoneId, kind: a.kind, permission: alertKindDef(a.kind).audiencePermission, severity: a.severity },
      { title: a.title, body: a.body },
      { ...alertData(a), url: `/alerts/${res.id}`, alertId: res.id }
    );
    await supabase.rpc("ops_mark_alert_pushed", { p_id: res.id });
  } catch (e) {
    captureError(e, { source: "alerts/event", attrs: { kind: a.kind } });
  }
}
