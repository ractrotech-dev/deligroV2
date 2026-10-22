import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ManagerScope } from "@/lib/auth/manager-scope";
import { encodeCursor, visibleKinds, type InboxItem } from "@/lib/ops/alerts-contract";
import { listAlerts, type Viewer } from "@/lib/data-access/manager-alerts";

/**
 * The signed-in person's inbox (the shared `user_notifications`, 0087): only
 * their own rows, newest first. Marking read is the person's own state, not an
 * operational action, so it is not audited (scripts/qa/manager-audit-coverage.ts
 * names it as allowed).
 */

type Row = { id: string; category: string; title: string; body: string; data: Record<string, unknown> | null; read_at: string | null; created_at: string };

export async function listInbox(
  userId: string,
  q: { cursor: { at: string; id: string } | null; unreadOnly: boolean; limit: number }
): Promise<{ items: InboxItem[]; nextCursor: string | null; unread: number }> {
  const db = createAdminClient();
  let query = db.from("user_notifications").select("id, category, title, body, data, read_at, created_at").eq("user_id", userId);
  if (q.unreadOnly) query = query.is("read_at", null);
  if (q.cursor) query = query.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  const [{ data, error }, unread] = await Promise.all([
    query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1),
    unreadOf(userId),
  ]);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ id: r.id, category: r.category, title: r.title, body: r.body, data: r.data ?? {}, readAt: r.read_at, createdAt: r.created_at })),
    nextCursor: more && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
    unread,
  };
}

async function unreadOf(userId: string): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
  if (error) throw error;
  return count ?? 0;
}

/** The badge: unread inbox rows, and the open / critical alerts the person can see. */
export async function unreadSummary(userId: string, scope: ManagerScope, viewer: Viewer, now: Date) {
  const [unread, alerts] = await Promise.all([
    unreadOf(userId),
    visibleKinds(viewer).length
      ? listAlerts(scope, viewer, { statuses: ["open", "acknowledged"], kinds: null, severities: ["critical"], zone: null, from: null, to: null, cursor: null, limit: 1 }, now)
      : Promise.resolve(null),
  ]);
  return { unread, openAlerts: alerts ? alerts.counts.open + alerts.counts.acknowledged : 0, criticalAlerts: alerts?.counts.critical ?? 0 };
}

export async function markRead(userId: string, target: { ids: string[] } | { all: true }): Promise<number> {
  let query = createAdminClient().from("user_notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null);
  if ("ids" in target) query = query.in("id", target.ids);
  const { error } = await query;
  if (error) throw error;
  return unreadOf(userId);
}
