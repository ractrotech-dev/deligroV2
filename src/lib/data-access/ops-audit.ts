import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The operations audit log (migration 0141): who did what, when, and why.
 *
 * Append-only in the database — no role can update or delete a row. Written
 * only through `log_ops_action()`, which records the actor the server has
 * already authorised. Call `logOpsAction` from a path that has run its role
 * and permission checks (AGENTS.md rule 5).
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

/**
 * For actions whose own write has already succeeded: an audit failure is
 * reported, never allowed to undo the action the person just took.
 */
export async function logOpsActionSafely(input: OpsActionInput): Promise<void> {
  try {
    await logOpsAction(input);
  } catch (err) {
    console.error("[ops-audit]", input.action, err instanceof Error ? err.message : String(err));
  }
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
