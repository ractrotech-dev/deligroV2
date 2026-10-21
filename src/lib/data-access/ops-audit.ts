import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The operations audit log (migration 0141): who did what, when, and why.
 *
 * Append-only in the database — no role can update or delete a row.
 *
 * **An audited change and its entry are one transaction.** A write to this
 * database is an RPC that changes the row and calls `_ops_log` itself (the
 * `ops_*` functions, `revoke_my_session`, triggers). `logOpsAction` — the
 * service-role `log_ops_action()` — is only for changes that happen outside
 * this database (an auth API call): log first, refuse the change if the log
 * fails, and record a `*.failed` entry if the change then fails. There is no
 * best-effort variant: an entry that can silently go missing is not an audit.
 */

export interface OpsActionInput {
  actorId: string;
  /** `area.verb`, e.g. `order.reassign`, `zone.create`, `session.revoke`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  zoneId?: string | null;
  /** Mandatory for manual interventions, corrections and status changes. */
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** Idempotency key: a replay returns the original row instead of a duplicate. */
  clientActionId?: string | null;
}

export async function logOpsAction(input: OpsActionInput): Promise<number> {
  const { data, error } = await createAdminClient().rpc("log_ops_action", {
    p_actor: input.actorId,
    p_action: input.action,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId ?? null,
    p_zone: input.zoneId ?? null,
    p_reason: input.reason ?? null,
    p_before: input.before ?? null,
    p_after: input.after ?? null,
    p_client_action_id: input.clientActionId ?? null,
  });
  if (error) throw error;
  return Number(data);
}


export interface ActivityItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  zoneId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ActivityPage {
  items: ActivityItem[];
  page: number;
  hasMore: boolean;
}

/** One person's own actions, newest first (Profile → Activity, §15.8). */
export async function listActivity(
  actorId: string,
  opts: { page: number; pageSize: number }
): Promise<ActivityPage> {
  const page = Math.max(1, Math.trunc(opts.page) || 1);
  const size = Math.min(100, Math.max(1, Math.trunc(opts.pageSize) || 50));
  const from = (page - 1) * size;
  // One extra row says whether there is a next page without a count query.
  const { data, error } = await createAdminClient()
    .from("ops_audit_log")
    .select("id, action, entity_type, entity_id, zone_id, reason, created_at")
    .eq("actor_id", actorId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + size);
  if (error) throw error;
  const rows = (data ?? []) as {
    id: number;
    action: string;
    entity_type: string;
    entity_id: string | null;
    zone_id: string | null;
    reason: string | null;
    created_at: string;
  }[];
  return {
    items: rows.slice(0, size).map((r) => ({
      id: Number(r.id),
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      zoneId: r.zone_id,
      reason: r.reason,
      createdAt: r.created_at,
    })),
    page,
    hasMore: rows.length > size,
  };
}
