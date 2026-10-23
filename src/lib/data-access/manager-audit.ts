import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { readByIds } from "@/lib/data-access/scoped-riders";
import { addDays, istDayStart } from "@/lib/metrics";
import { auditDiff, encodeCursor, redactAuditPayload, type AuditEntry, type AuditQuery } from "@/lib/ops/alerts-contract";

/**
 * The audit log for the Manager app (§16): admins read everything; a manager
 * with `manager.audit.view_zone` reads their zones' entries (entries with no
 * zone are admin-only). Read only — nobody edits it (0141 refuses even the
 * service role). Contact and bank details are redacted on the way out as a
 * backstop to the RPCs, which never write them.
 */

type Row = { id: number; actor_id: string; actor_role: string; action: string; entity_type: string; entity_id: string; zone_id: string | null; reason: string | null; before: unknown; after: unknown; client_action_id: string | null; created_at: string };
const COLUMNS = "id, actor_id, actor_role, action, entity_type, entity_id, zone_id, reason, before, after, client_action_id, created_at";

// The builder's generic is too deep to name; the filters only chain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function scoped(query: Chain, scope: ManagerScope, zone: string | null): Chain {
  const zones = scopeZoneIds(zone ? narrowScope(scope, zone) : scope);
  // `in` never matches a null zone: unzoned entries stay admin-only.
  return zones === null ? query : query.in("zone_id", zones as string[]);
}

function toEntry(r: Row, names: Map<string, string>): AuditEntry {
  return {
    id: Number(r.id), at: r.created_at,
    actor: { id: r.actor_id, name: names.get(r.actor_id) ?? "Staff", role: r.actor_role },
    action: r.action, entityType: r.entity_type, entityId: r.entity_id, zoneId: r.zone_id, reason: r.reason,
    before: (redactAuditPayload(r.before, r.action) as Record<string, unknown> | null) ?? null,
    after: (redactAuditPayload(r.after, r.action) as Record<string, unknown> | null) ?? null,
    clientActionId: r.client_action_id,
  };
}

async function namesOf(rows: Row[]): Promise<Map<string, string>> {
  const p = await readByIds<{ id: string; full_name: string | null }>("profiles", "id, full_name", "id", rows.map((r) => r.actor_id));
  return new Map(p.map((x) => [x.id, x.full_name?.trim() || "Staff"]));
}

export async function listAudit(scope: ManagerScope, q: AuditQuery): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  let query: Chain = scoped(createAdminClient().from("ops_audit_log").select(COLUMNS), scope, q.zone);
  if (q.actor) query = query.eq("actor_id", q.actor);
  if (q.actions) {
    // Codes and prefixes are [a-z_.] only (the parser checks), so they are
    // safe inside PostgREST's or-filter; `_` is escaped for LIKE.
    query = query.or(
      q.actions.map((a) => ("exact" in a ? `action.eq.${a.exact}` : `action.like.${a.prefix.replace(/_/g, "\\_")}*`)).join(",")
    );
  }
  if (q.entityType) query = query.eq("entity_type", q.entityType);
  if (q.entityId) query = query.eq("entity_id", q.entityId);
  if (q.from) query = query.gte("created_at", istDayStart(q.from).toISOString());
  if (q.to) query = query.lt("created_at", istDayStart(addDays(q.to, 1)).toISOString());
  if (q.cursor) query = query.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const names = await namesOf(page);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toEntry(r, names)),
    nextCursor: more && last ? encodeCursor({ at: last.created_at, id: String(last.id) }) : null,
  };
}

export async function getAuditEntry(scope: ManagerScope, id: number) {
  const query: Chain = scoped(createAdminClient().from("ops_audit_log").select(COLUMNS), scope, null);
  const { data, error } = await query.eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  const entry = toEntry(row, await namesOf([row]));
  return { entry, diff: auditDiff(entry.before, entry.after) };
}
