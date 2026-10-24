import "server-only";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SUPABASE_SERVICE_ROLE_KEY,
  isSupabaseConfigured,
} from "@/lib/supabase/config";
import type {
  ObsEnv,
  ObsIncidentStatus,
  ObsIssueStatus,
  ObsLevel,
  ObsSeverity,
} from "./types";

/**
 * The read side of observability.
 *
 * ## Authorization
 *
 * Every exported function begins with `await requireRole("developer")`. That is not
 * belt-and-braces on top of the layout's check — it is the check. These
 * functions reach for `createAdminClient()`, which bypasses RLS entirely, so
 * AGENTS.md rule 5 applies directly: every call needs an authorization check
 * above it in the same path. A layout guard protects a page; it does not
 * protect a function that a future route handler or Server Action might call.
 *
 * The access decision itself is recorded in `docs/OBSERVABILITY_PLAN.md` §12:
 * admin only. `manager` does not reach this, and there is no read-only tier —
 * Deligro has no admin sub-roles to hang one on, and inventing a permission
 * dimension for this feature alone would be a security change of its own.
 *
 * ## Why the service role at all
 *
 * The `obs_*` tables have RLS on with no policies (migration 0046), so there is
 * no authenticated path to them by design — the same containment `rate_limits`
 * and `vendor_login_credentials` use. Nothing here takes a table or column name
 * from a caller; the only user input that reaches a query is a filter value,
 * always through PostgREST's parameter binding.
 *
 * ## Degrading honestly
 *
 * If migration 0046 has not been applied, these return `notMigrated` rather
 * than throwing. An empty observability dashboard on an un-migrated database
 * looks exactly like a healthy platform, and an operator would believe it —
 * which is the failure mode this whole system exists to prevent. The console
 * says "not installed", not "all clear".
 */

/** PostgREST's "relation does not exist" — migration 0046 has not been applied. */
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_FUNCTION = "42883";

export type ObsRange = "15m" | "1h" | "24h" | "today" | "7d" | "30d";

export const OBS_RANGES: Array<{ value: ObsRange; label: string }> = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 hour" },
  { value: "today", label: "Today" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export function rangeStart(range: ObsRange): Date {
  const now = Date.now();
  switch (range) {
    case "15m":
      return new Date(now - 15 * 60_000);
    case "1h":
      return new Date(now - 60 * 60_000);
    case "24h":
      return new Date(now - 24 * 60 * 60_000);
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "7d":
      return new Date(now - 7 * 24 * 60 * 60_000);
    case "30d":
      return new Date(now - 30 * 24 * 60 * 60_000);
  }
}

/**
 * The window immediately before the current one, of the same length.
 *
 * What "↑ 32% compared with yesterday" is actually measured against. Comparing
 * a partial window to a full one is the classic way a dashboard invents a
 * collapse at one minute past midnight, so both sides are always the same
 * length.
 */
function previousWindow(range: ObsRange): { from: Date; to: Date } {
  const to = rangeStart(range);
  const span = Date.now() - to.getTime();
  return { from: new Date(to.getTime() - span), to };
}

/**
 * How long raw events are kept (migration 0046). The console quotes this
 * whenever it shows a figure that can only be computed from raw rows, so a
 * count that is really "in the last 14 days" never reads as "ever".
 */
const OBS_RAW_RETENTION_DAYS = 14;

/* ============================================================
   Shapes
   ============================================================ */

export interface ObsIssueRow {
  fingerprint: string;
  shortId: string;
  title: string;
  culprit: string | null;
  kind: string;
  level: string;
  env: ObsEnv;
  severity: ObsSeverity;
  severitySource: "auto" | "manual";
  status: ObsIssueStatus;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  /** Distinct signed-in people hit since first seen (0169); null before that migration. */
  usersAffected: number | null;
  releaseFirstSeen: string | null;
  releaseLastSeen: string | null;
  incidentId: number | null;
  assignedTo: string | null;
  resolutionNote: string | null;
  sampleEventId: number | null;
  sampleTraceId: string | null;
}

export interface ObsEventRowRead {
  id: number;
  occurredAt: string;
  env: ObsEnv;
  release: string | null;
  kind: string;
  level: ObsLevel;
  source: string;
  message: string;
  traceId: string | null;
  requestId: string | null;
  durationMs: number | null;
  httpMethod: string | null;
  httpRoute: string | null;
  httpStatus: number | null;
  provider: string | null;
  errorType: string | null;
  errorFingerprint: string | null;
  stack: string | null;
  actorRole: string | null;
  actorId: string | null;
  orderId: string | null;
  restaurantId: string | null;
  driverId: string | null;
  attrs: Record<string, unknown>;
}

export interface ObsDeploy {
  release: string;
  env: string;
  deployedAt: string;
  commitMessage: string | null;
  branch: string | null;
}

/** Every read returns this so a caller can tell "nothing wrong" from "not installed". */
export interface ObsResult<T> {
  data: T;
  /** Migration 0046 has not been applied on this database. */
  notMigrated: boolean;
}

function ok<T>(data: T): ObsResult<T> {
  return { data, notMigrated: false };
}

function missing<T>(fallback: T): ObsResult<T> {
  return { data: fallback, notMigrated: true };
}

function isNotMigrated(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_TABLE || error?.code === UNDEFINED_FUNCTION;
}

/**
 * Guard shared by every function here.
 *
 * The role check happens BEFORE the configuration check, deliberately. Ordering
 * it the other way round would answer an unauthorised caller with
 * "backend_not_configured" on an unconfigured deploy, which is a small
 * information leak and, worse, a habit — the project has already been bitten
 * once by a config path that widened access (finding H-1).
 */
async function guard(): Promise<boolean> {
  await requireRole("developer");
  return Boolean(isSupabaseConfigured && SUPABASE_SERVICE_ROLE_KEY);
}

/* ============================================================
   Issues
   ============================================================ */

export interface IssueFilters {
  env?: ObsEnv;
  status?: ObsIssueStatus | "all";
  severity?: ObsSeverity | "all";
  kind?: string;
  /** Free text over title and culprit. */
  q?: string;
  range?: ObsRange;
  limit?: number;
}

export async function listIssues(
  filters: IssueFilters = {}
): Promise<ObsResult<ObsIssueRow[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  let query = supabase
    .from("obs_issues")
    .select("*")
    .eq("env", filters.env ?? "production")
    .order("last_seen", { ascending: false })
    .limit(Math.min(filters.limit ?? 100, 300));

  // `resolved` and `ignored` are excluded by default rather than shown greyed
  // out: the issue list is a work queue, and a queue that includes finished
  // work stops being one.
  if (!filters.status || filters.status === "all") {
    query = query.in("status", ["open", "investigating", "regressed"]);
  } else {
    query = query.eq("status", filters.status);
  }

  if (filters.severity && filters.severity !== "all") {
    query = query.eq("severity", filters.severity);
  }
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.range) query = query.gte("last_seen", rangeStart(filters.range).toISOString());
  if (filters.q) {
    // `or` with two ilike patterns. The value is bound by PostgREST; the commas
    // and parens are the operator's own syntax, so a `%` or a comma in the
    // search box is escaped rather than parsed.
    const safe = filters.q.replace(/[,()]/g, " ");
    query = query.or(`title.ilike.%${safe}%,culprit.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok((data ?? []).map(mapIssue));
}

export async function getIssue(
  shortId: string
): Promise<ObsResult<ObsIssueRow | null>> {
  if (!(await guard())) return missing(null);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_issues")
    .select("*")
    .eq("short_id", shortId.toUpperCase())
    .maybeSingle();

  if (error) {
    if (isNotMigrated(error)) return missing(null);
    throw error;
  }
  return ok(data ? mapIssue(data) : null);
}

/**
 * Blast radius, honestly bounded.
 *
 * Distinct users and orders can only be counted from raw events, which live 14
 * days. The window is returned alongside the numbers so the UI can say
 * "(last 14 days)" — a distinct count that silently shrinks when a partition is
 * dropped would be a number that lies about its own meaning.
 */
export interface IssueImpact {
  affectedUsers: number;
  affectedOrders: number;
  affectedRestaurants: number;
  windowDays: number;
  /** Events actually available to count — less than `occurrences` once rows expire. */
  sampledEvents: number;
}

export async function getIssueImpact(
  fingerprint: string
): Promise<ObsResult<IssueImpact>> {
  const empty: IssueImpact = {
    affectedUsers: 0,
    affectedOrders: 0,
    affectedRestaurants: 0,
    windowDays: OBS_RAW_RETENTION_DAYS,
    sampledEvents: 0,
  };
  if (!(await guard())) return missing(empty);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_events")
    .select("actor_id, order_id, restaurant_id")
    .eq("error_fingerprint", fingerprint)
    .limit(5000);

  if (error) {
    if (isNotMigrated(error)) return missing(empty);
    throw error;
  }

  const rows = (data ?? []) as Array<{
    actor_id: string | null;
    order_id: string | null;
    restaurant_id: string | null;
  }>;

  return ok({
    affectedUsers: new Set(rows.map((r) => r.actor_id).filter(Boolean)).size,
    affectedOrders: new Set(rows.map((r) => r.order_id).filter(Boolean)).size,
    affectedRestaurants: new Set(rows.map((r) => r.restaurant_id).filter(Boolean))
      .size,
    windowDays: OBS_RAW_RETENTION_DAYS,
    sampledEvents: rows.length,
  });
}

/** One person an issue hit (0169's obs_issue_people), with their name for the console. */
export interface IssuePerson {
  personKey: string;
  actorId: string | null;
  name: string | null;
  role: string | null;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Who an issue hit, most-hit first. Counted at ingest in the same atomic call
 * as the issue itself, so unlike the raw-event impact numbers these do not
 * shrink when old events expire. Empty before migration 0169.
 */
export async function getIssuePeople(fingerprint: string, limit = 50): Promise<ObsResult<IssuePerson[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_issue_people")
    .select("person_key, actor_id, actor_role, occurrences, first_seen, last_seen")
    .eq("fingerprint", fingerprint)
    .order("occurrences", { ascending: false })
    .limit(limit);
  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  const rows = (data ?? []) as Array<{
    person_key: string; actor_id: string | null; actor_role: string | null;
    occurrences: number | string; first_seen: string; last_seen: string;
  }>;
  const ids = rows.map((r) => r.actor_id).filter((v): v is string => !!v);
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await supabase.from("profiles").select("id, full_name").in("id", ids);
    for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null }>) {
      if (p.full_name) names.set(p.id, p.full_name);
    }
  }
  return ok(rows.map((r) => ({
    personKey: r.person_key,
    actorId: r.actor_id,
    name: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
    role: r.actor_role,
    occurrences: Number(r.occurrences),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  })));
}

/** An alert the developers were sent (0170): an issue that is new or came back. */
export interface IssueAlert {
  shortId: string;
  title: string;
  reason: "new" | "regressed";
  createdAt: string;
  notifiedAt: string | null;
}

/** Production alerts from the last `hours`, newest first. Empty before 0170. */
export async function listIssueAlerts(hours = 24): Promise<ObsResult<IssueAlert[]>> {
  if (!(await guard())) return missing([]);
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_issue_alerts")
    .select("short_id, title, reason, created_at, notified_at")
    .eq("env", "production")
    .gte("created_at", new Date(Date.now() - hours * 3_600_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok(((data ?? []) as Array<{ short_id: string; title: string; reason: "new" | "regressed"; created_at: string; notified_at: string | null }>).map((r) => ({
    shortId: r.short_id,
    title: r.title,
    reason: r.reason,
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
  })));
}

/** The most recent occurrences of one issue — the timeline and the stack source. */
export async function getIssueEvents(
  fingerprint: string,
  limit = 25
): Promise<ObsResult<ObsEventRowRead[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_events")
    .select("*")
    .eq("error_fingerprint", fingerprint)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok((data ?? []).map(mapEvent));
}

/* ============================================================
   Events / log viewer
   ============================================================ */

export interface EventFilters {
  env?: ObsEnv;
  level?: ObsLevel | "all";
  kind?: string;
  source?: string;
  provider?: string;
  traceId?: string;
  requestId?: string;
  orderId?: string;
  route?: string;
  q?: string;
  range?: ObsRange;
  limit?: number;
}

export async function listEvents(
  filters: EventFilters = {}
): Promise<ObsResult<ObsEventRowRead[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  let query = supabase
    .from("obs_events")
    .select("*")
    .eq("env", filters.env ?? "production")
    .gte("occurred_at", rangeStart(filters.range ?? "1h").toISOString())
    .order("occurred_at", { ascending: false })
    .limit(Math.min(filters.limit ?? 200, 500));

  if (filters.level && filters.level !== "all") {
    // A level filter is a floor, not an equality: asking for "warn" and being
    // shown warnings while errors are hidden is the opposite of what anyone
    // means by it.
    const ladder: ObsLevel[] = ["debug", "info", "warn", "error", "fatal"];
    query = query.in("level", ladder.slice(ladder.indexOf(filters.level)));
  }
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.provider) query = query.eq("provider", filters.provider);
  if (filters.traceId) query = query.eq("trace_id", filters.traceId);
  if (filters.requestId) query = query.eq("request_id", filters.requestId);
  if (filters.orderId) query = query.eq("order_id", filters.orderId);
  if (filters.route) query = query.eq("http_route", filters.route);
  if (filters.q) {
    const safe = filters.q.replace(/[,()]/g, " ");
    query = query.ilike("message", `%${safe}%`);
  }

  const { data, error } = await query;
  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok((data ?? []).map(mapEvent));
}

/**
 * One logical operation, oldest first.
 *
 * Ascending on purpose: a trace is read as a story, and the story runs forwards.
 * The issue list is descending because it is read as a queue.
 */
export async function getTrace(
  traceId: string
): Promise<ObsResult<ObsEventRowRead[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_events")
    .select("*")
    .eq("trace_id", traceId)
    .order("occurred_at", { ascending: true })
    .limit(300);

  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok((data ?? []).map(mapEvent));
}

/* ============================================================
   Deploys
   ============================================================ */

export async function listDeploys(
  env: ObsEnv = "production",
  limit = 10
): Promise<ObsResult<ObsDeploy[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_deploys")
    .select("*")
    .eq("env", env)
    .order("deployed_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok(
    (data ?? []).map((d: Record<string, unknown>) => ({
      release: String(d.release),
      env: String(d.env),
      deployedAt: String(d.deployed_at),
      commitMessage: (d.commit_message as string | null) ?? null,
      branch: (d.branch as string | null) ?? null,
    }))
  );
}

/**
 * The deploy that landed closest before an issue was first seen.
 *
 * Returns adjacency and a gap, never a verdict. Most deploys are innocent, and
 * a tool that announces "the deploy caused this" is wrong often enough to be
 * overruled once and ignored forever after. The console renders the gap and
 * lets the operator decide.
 */
export interface DeployCorrelation {
  deploy: ObsDeploy;
  minutesBefore: number;
}

export async function getDeployCorrelation(
  firstSeen: string,
  env: ObsEnv = "production"
): Promise<ObsResult<DeployCorrelation | null>> {
  if (!(await guard())) return missing(null);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_deploys")
    .select("*")
    .eq("env", env)
    .lte("deployed_at", firstSeen)
    .order("deployed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isNotMigrated(error)) return missing(null);
    throw error;
  }
  if (!data) return ok(null);

  const gapMs =
    new Date(firstSeen).getTime() - new Date(String(data.deployed_at)).getTime();
  const minutesBefore = Math.round(gapMs / 60_000);

  // Beyond six hours the two facts are not adjacent in any useful sense, and
  // presenting them side by side would imply a link the data does not support.
  if (minutesBefore > 360) return ok(null);

  return ok({
    deploy: {
      release: String(data.release),
      env: String(data.env),
      deployedAt: String(data.deployed_at),
      commitMessage: (data.commit_message as string | null) ?? null,
      branch: (data.branch as string | null) ?? null,
    },
    minutesBefore,
  });
}

/* ============================================================
   Incidents
   ============================================================ */

export interface ObsIncident {
  id: number;
  shortId: string;
  title: string;
  summary: string | null;
  severity: ObsSeverity;
  status: ObsIncidentStatus;
  env: string;
  ownerId: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  resolution: string | null;
}

export interface ObsIncidentNote {
  id: number;
  kind: string;
  body: string;
  authorId: string | null;
  createdAt: string;
}

export async function listIncidents(
  includeClosed = false
): Promise<ObsResult<ObsIncident[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  let query = supabase
    .from("obs_incidents")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(100);

  if (!includeClosed) query = query.neq("status", "closed");

  const { data, error } = await query;
  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok((data ?? []).map(mapIncident));
}

export async function getIncident(shortId: string): Promise<
  ObsResult<{ incident: ObsIncident | null; notes: ObsIncidentNote[]; issues: ObsIssueRow[] }>
> {
  const empty = { incident: null, notes: [], issues: [] };
  if (!(await guard())) return missing(empty);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_incidents")
    .select("*")
    .eq("short_id", shortId.toUpperCase())
    .maybeSingle();

  if (error) {
    if (isNotMigrated(error)) return missing(empty);
    throw error;
  }
  if (!data) return ok(empty);

  const incident = mapIncident(data);
  const [notes, issues] = await Promise.all([
    supabase
      .from("obs_incident_notes")
      .select("*")
      .eq("incident_id", incident.id)
      .order("created_at", { ascending: true }),
    supabase.from("obs_issues").select("*").eq("incident_id", incident.id),
  ]);

  return ok({
    incident,
    notes: (notes.data ?? []).map((n: Record<string, unknown>) => ({
      id: Number(n.id),
      kind: String(n.kind),
      body: String(n.body),
      authorId: (n.author_id as string | null) ?? null,
      createdAt: String(n.created_at),
    })),
    issues: (issues.data ?? []).map(mapIssue),
  });
}

/* ============================================================
   Alerts
   ============================================================ */

export interface ObsAlertRule {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  env: string;
  metric: string;
  dimension: string | null;
  key: string | null;
  comparator: string;
  threshold: number;
  windowMin: number;
  minSamples: number;
  cooldownMin: number;
  severity: ObsSeverity;
}

export interface ObsAlertFiring {
  id: number;
  ruleId: number;
  ruleName: string;
  firedAt: string;
  observed: number;
  threshold: number;
  sampleCount: number;
  message: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
}

export async function listAlertRules(): Promise<ObsResult<ObsAlertRule[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_alert_rules")
    .select("*")
    .order("severity")
    .order("name");

  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok(
    (data ?? []).map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      name: String(r.name),
      description: (r.description as string | null) ?? null,
      enabled: Boolean(r.enabled),
      env: String(r.env),
      metric: String(r.metric),
      dimension: (r.dimension as string | null) ?? null,
      key: (r.key as string | null) ?? null,
      comparator: String(r.comparator),
      threshold: Number(r.threshold),
      windowMin: Number(r.window_min),
      minSamples: Number(r.min_samples),
      cooldownMin: Number(r.cooldown_min),
      severity: r.severity as ObsSeverity,
    }))
  );
}

export async function listAlertFirings(
  activeOnly = false,
  limit = 50
): Promise<ObsResult<ObsAlertFiring[]>> {
  if (!(await guard())) return missing([]);

  const supabase = createAdminClient();
  let query = supabase
    .from("obs_alert_firings")
    .select("*, obs_alert_rules(name)")
    .order("fired_at", { ascending: false })
    .limit(limit);

  if (activeOnly) query = query.is("resolved_at", null);

  const { data, error } = await query;
  if (error) {
    if (isNotMigrated(error)) return missing([]);
    throw error;
  }
  return ok(
    (data ?? []).map((f: Record<string, unknown>) => {
      const rule = f.obs_alert_rules as { name?: string } | null;
      return {
        id: Number(f.id),
        ruleId: Number(f.rule_id),
        ruleName: rule?.name ?? "Rule",
        firedAt: String(f.fired_at),
        observed: Number(f.observed),
        threshold: Number(f.threshold),
        sampleCount: Number(f.sample_count),
        message: String(f.message),
        resolvedAt: (f.resolved_at as string | null) ?? null,
        acknowledgedAt: (f.acknowledged_at as string | null) ?? null,
      };
    })
  );
}

/* ============================================================
   Search
   ============================================================ */

export type ObsSearchKind =
  | "issue"
  | "trace"
  | "request"
  | "order"
  | "incident"
  | "text";

/**
 * What did the operator paste?
 *
 * Dispatching on shape rather than asking them to choose a search mode: during
 * an incident the thing in the clipboard is whatever the last screen showed,
 * and making someone classify it first is a step that only exists because the
 * software could not be bothered to look.
 */
export function classifySearch(raw: string): {
  kind: ObsSearchKind;
  value: string;
} {
  const q = raw.trim();
  if (/^DEL-\d+$/i.test(q)) return { kind: "issue", value: q.toUpperCase() };
  if (/^INC-\d+$/i.test(q)) return { kind: "incident", value: q.toUpperCase() };
  if (/^trace_[0-9A-Za-z]+$/.test(q)) return { kind: "trace", value: q };
  if (/^req_[0-9A-Za-z]+$/.test(q)) return { kind: "request", value: q };
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)
  ) {
    return { kind: "order", value: q.toLowerCase() };
  }
  return { kind: "text", value: q };
}

/* ============================================================
   Mappers
   ============================================================ */

function mapIssue(row: Record<string, unknown>): ObsIssueRow {
  return {
    fingerprint: String(row.fingerprint),
    shortId: String(row.short_id),
    title: String(row.title),
    culprit: (row.culprit as string | null) ?? null,
    kind: String(row.kind),
    level: String(row.level),
    env: row.env as ObsEnv,
    severity: row.severity as ObsSeverity,
    severitySource: row.severity_source as "auto" | "manual",
    status: row.status as ObsIssueStatus,
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen),
    occurrences: Number(row.occurrences),
    usersAffected: row.users_affected === undefined || row.users_affected === null ? null : Number(row.users_affected),
    releaseFirstSeen: (row.release_first_seen as string | null) ?? null,
    releaseLastSeen: (row.release_last_seen as string | null) ?? null,
    incidentId: row.incident_id ? Number(row.incident_id) : null,
    assignedTo: (row.assigned_to as string | null) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    sampleEventId: row.sample_event_id ? Number(row.sample_event_id) : null,
    sampleTraceId: (row.sample_trace_id as string | null) ?? null,
  };
}

function mapEvent(row: Record<string, unknown>): ObsEventRowRead {
  return {
    id: Number(row.id),
    occurredAt: String(row.occurred_at),
    env: row.env as ObsEnv,
    release: (row.release as string | null) ?? null,
    kind: String(row.kind),
    level: row.level as ObsLevel,
    source: String(row.source),
    message: String(row.message),
    traceId: (row.trace_id as string | null) ?? null,
    requestId: (row.request_id as string | null) ?? null,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    httpMethod: (row.http_method as string | null) ?? null,
    httpRoute: (row.http_route as string | null) ?? null,
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    provider: (row.provider as string | null) ?? null,
    errorType: (row.error_type as string | null) ?? null,
    errorFingerprint: (row.error_fingerprint as string | null) ?? null,
    stack: (row.stack as string | null) ?? null,
    actorRole: (row.actor_role as string | null) ?? null,
    actorId: (row.actor_id as string | null) ?? null,
    orderId: (row.order_id as string | null) ?? null,
    restaurantId: (row.restaurant_id as string | null) ?? null,
    driverId: (row.driver_id as string | null) ?? null,
    attrs: (row.attrs as Record<string, unknown>) ?? {},
  };
}

function mapIncident(row: Record<string, unknown>): ObsIncident {
  return {
    id: Number(row.id),
    shortId: String(row.short_id),
    title: String(row.title),
    summary: (row.summary as string | null) ?? null,
    severity: row.severity as ObsSeverity,
    status: row.status as ObsIncidentStatus,
    env: String(row.env),
    ownerId: (row.owner_id as string | null) ?? null,
    detectedAt: String(row.detected_at),
    resolvedAt: (row.resolved_at as string | null) ?? null,
    closedAt: (row.closed_at as string | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
  };
}

export { previousWindow };

/* ============================================================
   Sign-ins (0171) — the Security tab
   ============================================================ */

export interface SignInRow {
  occurredAt: string;
  method: "otp" | "password";
  outcome: "success" | "failure";
  reason: string | null;
  actorId: string | null;
  name: string | null;
  role: string | null;
  phoneTail: string | null;
  device: string | null;
  country: string | null;
  newDevice: boolean;
  newCountry: boolean;
}

export interface SignInSummary {
  days: number;
  total: number;
  successes: number;
  failures: number;
  /** New device or new country for that person, newest first. */
  risky: SignInRow[];
  /** Accounts with the most failed attempts. */
  failingAccounts: { actorId: string | null; name: string | null; role: string | null; phoneTail: string | null; failures: number; lastAt: string }[];
  countries: { country: string; count: number }[];
  recentFailures: SignInRow[];
}

/** The last `days` of sign-ins in production (at most 5,000 rows read). Empty before 0171. */
export async function getSignInSummary(days = 7): Promise<ObsResult<SignInSummary>> {
  const empty: SignInSummary = { days, total: 0, successes: 0, failures: 0, risky: [], failingAccounts: [], countries: [], recentFailures: [] };
  if (!(await guard())) return missing(empty);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("obs_sign_ins")
    .select("occurred_at, method, outcome, reason, actor_id, actor_role, phone_tail, device, country, new_device, new_country")
    .eq("env", "production")
    .gte("occurred_at", new Date(Date.now() - days * 86_400_000).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(5000);
  if (error) {
    if (isNotMigrated(error)) return missing(empty);
    throw error;
  }
  type Raw = {
    occurred_at: string; method: "otp" | "password"; outcome: "success" | "failure"; reason: string | null;
    actor_id: string | null; actor_role: string | null; phone_tail: string | null; device: string | null;
    country: string | null; new_device: boolean; new_country: boolean;
  };
  const raw = (data ?? []) as Raw[];

  const ids = [...new Set(raw.map((r) => r.actor_id).filter((v): v is string => !!v))].slice(0, 500);
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await supabase.from("profiles").select("id, full_name").in("id", ids);
    for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null }>) if (p.full_name) names.set(p.id, p.full_name);
  }
  const rows: SignInRow[] = raw.map((r) => ({
    occurredAt: r.occurred_at, method: r.method, outcome: r.outcome, reason: r.reason,
    actorId: r.actor_id, name: r.actor_id ? (names.get(r.actor_id) ?? null) : null, role: r.actor_role,
    phoneTail: r.phone_tail, device: r.device, country: r.country, newDevice: r.new_device, newCountry: r.new_country,
  }));

  const failures = rows.filter((r) => r.outcome === "failure");
  const byAccount = new Map<string, SignInSummary["failingAccounts"][number]>();
  for (const r of failures) {
    const key = r.actorId ?? `phone:${r.phoneTail ?? "?"}`;
    const cur = byAccount.get(key) ?? { actorId: r.actorId, name: r.name, role: r.role, phoneTail: r.phoneTail, failures: 0, lastAt: r.occurredAt };
    cur.failures += 1;
    if (r.occurredAt > cur.lastAt) cur.lastAt = r.occurredAt;
    byAccount.set(key, cur);
  }
  const countries = new Map<string, number>();
  for (const r of rows) if (r.country) countries.set(r.country, (countries.get(r.country) ?? 0) + 1);

  return ok({
    days,
    total: rows.length,
    successes: rows.length - failures.length,
    failures: failures.length,
    risky: rows.filter((r) => r.outcome === "success" && (r.newDevice || r.newCountry)).slice(0, 20),
    failingAccounts: [...byAccount.values()].sort((a, b) => b.failures - a.failures).slice(0, 15),
    countries: [...countries.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    recentFailures: failures.slice(0, 20),
  });
}
