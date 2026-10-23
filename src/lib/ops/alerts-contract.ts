import { isCursorTime } from "@/lib/ops/cursor-time";
import { isUuid } from "@/lib/auth/manager-scope";
import { ALERT_KINDS, THRESHOLD_BOUNDS, alertKindDef, type AlertUnit, type OpsAlertKind } from "@/lib/ops/alerts/catalog";
import { isOpsAlertKind } from "@/lib/ops-alerts/kinds";

/**
 * The contract of the Alerts, thresholds, inbox and audit-log endpoints
 * (Phase 8, §14–§16) — pure, shared by the routes, the admin pages, the
 * contract check and the tests. English only.
 */

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: string;
  kind: OpsAlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  body: string;
  zoneId: string | null;
  entity: { type: string; id: string };
  openedAt: string;
  lastSeenAt: string;
  reopenCount: number;
  acknowledgedBy: { id: string; name: string } | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: { id: string; name: string } | null;
}

export interface AlertRule {
  kind: OpsAlertKind;
  zoneId: string | null;
  inherited: boolean;
  enabled: boolean;
  threshold: number | null;
  unit: AlertUnit;
  windowMinutes: number | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: string | null;
  label: string;
  description: string;
}

export interface InboxItem {
  id: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: { id: string; name: string; role: string };
  action: string;
  entityType: string;
  entityId: string;
  zoneId: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  clientActionId: string | null;
}

export type AlertRow = {
  id: string; kind: string; severity: string; status: string; title: string; body: string; zone_id: string | null;
  entity_type: string; entity_id: string; opened_at: string; last_seen_at: string; reopen_count: number;
  acknowledged_by: string | null; acknowledged_at: string | null; resolved_at: string | null; resolution: string | null; resolved_by: string | null;
};
export const ALERT_COLUMNS =
  "id, kind, severity, status, title, body, zone_id, entity_type, entity_id, opened_at, last_seen_at, reopen_count, acknowledged_by, acknowledged_at, resolved_at, resolution, resolved_by";

export function toAlert(r: AlertRow, names: Map<string, string>): Alert {
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? "Staff" } : null);
  return {
    id: r.id,
    kind: r.kind as OpsAlertKind,
    severity: r.severity as AlertSeverity,
    status: r.status as AlertStatus,
    title: r.title,
    body: r.body,
    zoneId: r.zone_id,
    entity: { type: r.entity_type, id: r.entity_id },
    openedAt: r.opened_at,
    lastSeenAt: r.last_seen_at,
    reopenCount: Number(r.reopen_count) || 0,
    acknowledgedBy: person(r.acknowledged_by),
    acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    resolvedBy: person(r.resolved_by),
  };
}

/**
 * A manager sees an alert only if they could act on it: platform-wide alerts
 * are incidents only, and the finance, marketing and support kinds need their
 * switch. Admins see everything. (Zones are applied by the query.)
 */
export function alertVisible(
  a: { kind: string; zoneId: string | null },
  viewer: { admin: boolean; permissions: Record<string, boolean> }
): boolean {
  if (viewer.admin) return true;
  if (a.zoneId === null && a.kind !== "incident") return false;
  if (!isOpsAlertKind(a.kind)) return false;
  const perm = alertKindDef(a.kind).audiencePermission;
  return !perm || viewer.permissions[perm] === true;
}

/** The kinds a viewer may see at all — the list query filters by them. */
export function visibleKinds(viewer: { admin: boolean; permissions: Record<string, boolean> }): OpsAlertKind[] {
  return ALERT_KINDS.filter((k) => viewer.admin || !k.audiencePermission || viewer.permissions[k.audiencePermission] === true).map((k) => k.kind);
}

// ── queries and bodies ─────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);
type Bad = { error: "bad_request"; field: string };
const bad = (field: string): Bad => ({ error: "bad_request", field });

export interface AlertQuery {
  statuses: AlertStatus[];
  kinds: OpsAlertKind[] | null;
  severities: AlertSeverity[] | null;
  zone: string | null;
  from: string | null;
  to: string | null;
  cursor: { at: string; id: string } | null;
  limit: number;
}

export function encodeCursor(c: { at: string; id: string }): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}
export function decodeCursor(raw: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    return at && id && isCursorTime(at) && (isUuid(id) || /^\d+$/.test(id)) ? { at, id } : null;
  } catch {
    return null;
  }
}

export function parseAlertQuery(sp: URLSearchParams): AlertQuery | Bad {
  const statuses = list(sp.get("status")) ?? ["open", "acknowledged"];
  if (statuses.some((s) => !["open", "acknowledged", "resolved"].includes(s))) return bad("status");
  const kinds = list(sp.get("kind"));
  if (kinds?.some((k) => !isOpsAlertKind(k))) return bad("kind");
  const severities = list(sp.get("severity"));
  if (severities?.some((s) => !["info", "warning", "critical"].includes(s))) return bad("severity");
  const zone = sp.get("zone");
  if (zone && !isUuid(zone)) return bad("zone");
  const from = sp.get("from");
  const to = sp.get("to");
  if (from && !DAY.test(from)) return bad("from");
  if (to && !DAY.test(to)) return bad("to");
  const rawCursor = sp.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return bad("cursor");
  const rawLimit = sp.get("limit");
  if (rawLimit !== null && (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) return bad("limit");
  return {
    statuses: statuses as AlertStatus[], kinds: kinds as OpsAlertKind[] | null, severities: severities as AlertSeverity[] | null,
    zone: zone?.toLowerCase() ?? null, from, to, cursor, limit: rawLimit ? Number(rawLimit) : 50,
  };
}

const cidOf = (b: Record<string, unknown>) => (typeof b.clientActionId === "string" && isUuid(b.clientActionId) ? b.clientActionId : null);
const textOf = (v: unknown, min: number, max: number) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : null;
};

export type ParseFail = { ok: false; status: 400; error: "bad_request" | "reason_required" | "bad_threshold"; field?: string };

export function parseAlertAction(b: Record<string, unknown> | null):
  { ok: true; value: { action: "acknowledge" | "resolve"; note: string | null; clientActionId: string } } | ParseFail {
  if (!b) return { ok: false, status: 400, error: "bad_request", field: "body" };
  const cid = cidOf(b);
  if (!cid) return { ok: false, status: 400, error: "bad_request", field: "clientActionId" };
  if (b.action !== "acknowledge" && b.action !== "resolve") return { ok: false, status: 400, error: "bad_request", field: "action" };
  const note = textOf(b.note, 3, 300);
  if (b.action === "resolve" && !note) return { ok: false, status: 400, error: "reason_required" };
  return { ok: true, value: { action: b.action, note, clientActionId: cid } };
}

export function parseIncident(b: Record<string, unknown> | null):
  { ok: true; value: { title: string; body: string; severity: "warning" | "critical"; zoneId: string; clientActionId: string } } | ParseFail {
  if (!b) return { ok: false, status: 400, error: "bad_request", field: "body" };
  const cid = cidOf(b);
  if (!cid) return { ok: false, status: 400, error: "bad_request", field: "clientActionId" };
  const title = textOf(b.title, 3, 120);
  if (!title) return { ok: false, status: 400, error: "bad_request", field: "title" };
  const body = textOf(b.body, 3, 1000);
  if (!body) return { ok: false, status: 400, error: "bad_request", field: "body" };
  if (b.severity !== "warning" && b.severity !== "critical") return { ok: false, status: 400, error: "bad_request", field: "severity" };
  if (typeof b.zoneId !== "string" || !isUuid(b.zoneId)) return { ok: false, status: 400, error: "bad_request", field: "zoneId" };
  return { ok: true, value: { title, body, severity: b.severity, zoneId: b.zoneId.toLowerCase(), clientActionId: cid } };
}

/** A threshold change; the bounds per unit match ops_set_alert_rule (0166). */
export function parseRuleBody(b: Record<string, unknown> | null):
  { ok: true; value: { kind: OpsAlertKind; zoneId: string | null; enabled: boolean; threshold: number | null; windowMinutes: number | null; clientActionId: string } } | ParseFail {
  if (!b) return { ok: false, status: 400, error: "bad_request", field: "body" };
  const cid = cidOf(b);
  if (!cid) return { ok: false, status: 400, error: "bad_request", field: "clientActionId" };
  if (!isOpsAlertKind(b.kind)) return { ok: false, status: 400, error: "bad_request", field: "kind" };
  if (b.zoneId !== null && (typeof b.zoneId !== "string" || !isUuid(b.zoneId))) return { ok: false, status: 400, error: "bad_request", field: "zoneId" };
  if (typeof b.enabled !== "boolean") return { ok: false, status: 400, error: "bad_request", field: "enabled" };
  const def = alertKindDef(b.kind);
  const threshold = b.threshold === null || b.threshold === undefined ? null : Number(b.threshold);
  const window = b.windowMinutes === null || b.windowMinutes === undefined ? null : Number(b.windowMinutes);
  if (def.unit === "none") {
    if (threshold !== null) return { ok: false, status: 400, error: "bad_threshold" };
  } else {
    const range = THRESHOLD_BOUNDS[def.unit];
    if (threshold === null || !Number.isFinite(threshold) || threshold < range.min || threshold > range.max) {
      return { ok: false, status: 400, error: "bad_threshold" };
    }
  }
  if (window !== null && (!Number.isInteger(window) || window < 5 || window > 10080)) return { ok: false, status: 400, error: "bad_threshold" };
  return { ok: true, value: { kind: b.kind, zoneId: (b.zoneId as string | null)?.toLowerCase() ?? null, enabled: b.enabled, threshold, windowMinutes: window, clientActionId: cid } };
}

export type ActionFilter = { exact: string } | { prefix: string };

export interface AuditQuery {
  actor: string | null;
  /** Any of these (codes, or prefixes from `x.*`); null = every action. */
  actions: ActionFilter[] | null;
  entityType: string | null;
  entityId: string | null;
  zone: string | null;
  from: string | null;
  to: string | null;
  cursor: { at: string; id: string } | null;
  limit: number;
}

export function parseAuditQuery(sp: URLSearchParams): AuditQuery | Bad {
  const actor = sp.get("actor");
  if (actor && !isUuid(actor)) return bad("actor");
  // `actions` is a comma list of codes and `x.*` prefixes (an area such as
  // Orders spans order.* and delivery.*); `action` is the single form.
  const rawActions = [sp.get("actions"), sp.get("action")].filter((x): x is string => !!x).flatMap((x) => x.split(","))
    .map((x) => x.trim()).filter(Boolean);
  let actions: AuditQuery["actions"] = null;
  if (rawActions.length) {
    if (rawActions.length > 20) return bad("actions");
    actions = [];
    for (const a of rawActions) {
      if (/^[a-z_]+(\.[a-z_]+)*\.\*$/.test(a)) actions.push({ prefix: a.slice(0, -1) });
      else if (/^[a-z_]+(\.[a-z_]+){1,3}$/.test(a)) actions.push({ exact: a });
      else return bad(sp.get("actions") ? "actions" : "action");
    }
  }
  const entityType = sp.get("entityType");
  if (entityType && !/^[a-z_]{2,40}$/.test(entityType)) return bad("entityType");
  const entityId = sp.get("entityId");
  if (entityId && !/^[A-Za-z0-9:_-]{1,80}$/.test(entityId)) return bad("entityId");
  const zone = sp.get("zone");
  if (zone && !isUuid(zone)) return bad("zone");
  const from = sp.get("from");
  const to = sp.get("to");
  if (from && !DAY.test(from)) return bad("from");
  if (to && !DAY.test(to)) return bad("to");
  const rawCursor = sp.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return bad("cursor");
  const rawLimit = sp.get("limit");
  if (rawLimit !== null && (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) return bad("limit");
  return {
    actor: actor?.toLowerCase() ?? null, actions, entityType, entityId, zone: zone?.toLowerCase() ?? null, from, to, cursor,
    limit: rawLimit ? Number(rawLimit) : 50,
  };
}

// ── audit payloads ─────────────────────────────────────────────────────────

/**
 * Keys that name contact, identity, payment or credential data. `account` alone
 * is NOT one — a rider's account status is {account:'active'} — but an account
 * *number* is; `bank` takes the whole object with it.
 */
const PRIVATE_KEY =
  /phone|mobile|email|address|account_?(no|num)|ifsc|aadhaar|aadhar|\bpan\b|^pan|upi|licen[cs]e|bank|token|passw|passcode|^otp|otp$|vehicle|secret/i;
/** Free-text keys that are private only for one action (the customer's own words about their door). */
const ACTION_PRIVATE_KEY: Record<string, RegExp> = { "order.correct.address_note": /^note$/i };
/** A value that is itself contact data: an Indian mobile number (optionally +91) or an email address. */
const PRIVATE_VALUE = [/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/, /[^\s@]+@[^\s@]+\.[^\s@]+/];
const REDACTED = "[redacted]";

/**
 * A backstop on top of the RPCs, which never write contact or bank details
 * into before/after: any key that looks like one, and any text that carries a
 * phone number or an email address, is replaced, at any depth. `action` names
 * the audit action so a key that is private only there (an address note) is
 * caught too.
 */
export function redactAuditPayload(v: unknown, action?: string): unknown {
  const actionKey = action ? ACTION_PRIVATE_KEY[action] : undefined;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, PRIVATE_KEY.test(k) || actionKey?.test(k) ? REDACTED : walk(y)])
      );
    }
    if (typeof x === "string" && PRIVATE_VALUE.some((re) => re.test(x))) return REDACTED;
    return x;
  };
  return walk(v);
}

/** The changed leaves between two audit payloads, as flat dotted paths. */
export function auditDiff(before: unknown, after: unknown): { path: string; before: unknown; after: unknown }[] {
  const out: { path: string; before: unknown; after: unknown }[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  const walk = (a: unknown, b: unknown, path: string) => {
    if (isObj(a) || isObj(b)) {
      const keys = new Set([...Object.keys(isObj(a) ? a : {}), ...Object.keys(isObj(b) ? b : {})]);
      for (const k of [...keys].sort()) walk(isObj(a) ? a[k] : undefined, isObj(b) ? b[k] : undefined, path ? `${path}.${k}` : k);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a ?? null, after: b ?? null });
  };
  walk(before ?? {}, after ?? {}, "");
  return out;
}
