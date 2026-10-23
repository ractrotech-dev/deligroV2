import { notifyTicketEscalated } from "@/lib/notifications/ticket-escalation";
import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { narrowScope, scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyUser, type NotificationRole } from "@/lib/notifications/notify-user";
import { notifyStaff } from "@/lib/notifications/ops-notify";
import { raiseEventAlert, loadAlertRules } from "@/lib/ops/alerts/engine";
import { alertFor } from "@/lib/ops/alerts/evaluate";
import { effectiveRule } from "@/lib/ops/alerts/catalog";
import { readByIds } from "@/lib/data-access/scoped-riders";
import { categoryLabel } from "@/lib/support/rules";
import { orderShortCode } from "@/lib/ops/order-contract";
import { addDays, istDayKey, istDayStart } from "@/lib/metrics";
import { TICKET_COLUMNS } from "@/lib/ops/vendor-contract";
import { buildTicketThread, type ThreadMessageRow, type ThreadRow, type TicketThread } from "@/lib/ops/ticket-thread";
import {
  QUEUE_COLUMNS,
  TEAMS,
  TICKET_TRANSITIONS,
  contractRole,
  encodeCursor,
  isUrgent,
  mapSupportRpcError,
  toTicketListItem,
  type QueueRow,
  type Team,
  type TicketCounts,
  type TicketEvent,
  type TicketListItem,
  type TicketQuery,
  type TicketStatusDb,
} from "@/lib/ops/support-contract";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

export type { TicketThread };

/**
 * The support queue for the Manager app (§11) — built on the ONE copy of the
 * ticket tables (0064 / 0087) and the audited RPCs (0145, 0165). Every read
 * is limited to the manager's zones; a ticket with no zone is admin-only.
 * Every write is one RPC that changes and logs together; side effects (the
 * requester's push, the assignee's, an escalation's) run only when the RPC
 * reports it was not a replay.
 */

const BUCKET = "support-attachments";
const NOT_FOUND: OpsResult = { ok: false, status: 404, error: "not_found" };
const MAX_URGENT = 100;

type Db = ReturnType<typeof createAdminClient>;
// The builder's generic is too deep to name; the filters only chain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function scoped(query: Chain, scope: ManagerScope, zone: string | null): Chain {
  const zones = scopeZoneIds(zone ? narrowScope(scope, zone) : scope);
  // `in` never matches a null zone, so unzoned tickets stay admin-only.
  return zones ? query.in("zone_id", zones as string[]) : query;
}

async function scopedTicket(scope: ManagerScope, id: string): Promise<(ThreadRow & QueueRow) | null> {
  const query = createAdminClient()
    .from("support_tickets")
    .select(`${QUEUE_COLUMNS}, resolution, restaurants(name)`)
    .eq("id", id);
  const { data, error } = await scoped(query, scope, null).maybeSingle();
  if (error) throw error;
  return (data as (ThreadRow & QueueRow) | null) ?? null;
}

async function names(db: Db, people: string[], shops: string[]) {
  const [p, s] = await Promise.all([
    readByIds<{ id: string; full_name: string | null }>("profiles", "id, full_name", "id", [...new Set(people.filter(Boolean))]),
    readByIds<{ id: string; name: string | null }>("restaurants", "id, name", "id", [...new Set(shops.filter(Boolean))]),
  ]);
  void db;
  return {
    people: new Map(p.map((x) => [x.id, x.full_name?.trim() || "User"])),
    shops: new Map(s.map((x) => [x.id, x.name?.trim() || "Shop"])),
  };
}

// ── queue ─────────────────────────────────────────────────────────────────

/** An id no ticket has: a rider with no tickets matches nothing. */
const NO_TICKET = "00000000-0000-0000-0000-000000000000";

function applyFilters(query: Chain, q: TicketQuery, viewerId: string, riderTickets: string[] | null): Chain {
  let out = query;
  if (q.statuses) out = out.in("status", q.statuses);
  if (q.categories) out = out.in("category", q.categories);
  if (q.priorities) out = out.in("priority", q.priorities);
  if (q.requesterRoles) out = out.in("requester_role", q.requesterRoles);
  if (q.from) out = out.gte("created_at", istDayStart(q.from).toISOString());
  if (q.to) out = out.lt("created_at", istDayStart(addDays(q.to, 1)).toISOString());
  if (q.assignee === "me") out = out.eq("assigned_to", viewerId);
  else if (q.assignee === "unassigned") out = out.is("assigned_to", null);
  else if (q.assignee) out = out.eq("assigned_to", q.assignee);
  if (q.team) out = out.eq("team", q.team);
  if (q.vendor) out = out.eq("restaurant_id", q.vendor);
  // The rider's own tickets and those about orders they delivered, found in the
  // database (ops_rider_ticket_ids): not the last 300 deliveries.
  if (q.rider) out = riderTickets && riderTickets.length ? out.in("id", riderTickets) : out.eq("requester_id", q.rider).eq("id", NO_TICKET);
  if (q.q?.kind === "number") out = out.eq("number", q.q.value);
  else if (q.q?.kind === "text") out = out.ilike("subject", `%${q.q.value.replace(/[%_,()]/g, " ")}%`);
  return out;
}

/** Unread per ticket: the requester's messages since staff last answered (one grouped read, ops_ticket_unread_counts). */
async function unreadCounts(db: Db, rows: QueueRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const { data, error } = await db.rpc("ops_ticket_unread_counts", { p_ticket_ids: rows.map((r) => r.id) });
  if (error) throw error;
  for (const r of (data ?? []) as { ticket_id: string; unread: number }[]) {
    if (Number(r.unread) > 0) out.set(r.ticket_id, Number(r.unread));
  }
  return out;
}

async function countsFor(db: Db, scope: ManagerScope, zone: string | null, viewerId: string): Promise<TicketCounts> {
  const count = async (apply: (q: Chain) => Chain) => {
    const base = db.from("support_tickets").select("id", { count: "exact", head: true });
    const { count: n, error } = await apply(scoped(base, scope, zone));
    if (error) throw error;
    return n ?? 0;
  };
  const statuses: TicketStatusDb[] = ["open", "in_progress", "waiting_on_requester", "escalated", "resolved", "closed"];
  const active = ["open", "in_progress", "waiting_on_requester", "escalated"];
  const [byStatus, unassigned, mine] = await Promise.all([
    Promise.all(statuses.map((s) => count((q) => q.eq("status", s)))),
    count((q) => q.in("status", active).is("assigned_to", null)),
    count((q) => q.in("status", active).eq("assigned_to", viewerId)),
  ]);
  const out = Object.fromEntries(statuses.map((s, i) => [s, byStatus[i]])) as Record<TicketStatusDb, number>;
  return { ...out, unassigned, mine };
}

export async function listTickets(
  scope: ManagerScope,
  viewer: OpsActor,
  q: TicketQuery,
  now: Date
): Promise<{ items: TicketListItem[]; nextCursor: string | null; counts: TicketCounts | null }> {
  const db = createAdminClient();
  let riderTickets: string[] | null = null;
  if (q.rider) {
    const zones = scopeZoneIds(q.zone ? narrowScope(scope, q.zone) : scope);
    const { data, error: rErr } = await db.rpc("ops_rider_ticket_ids", {
      p_rider: q.rider, p_zone_ids: zones === null ? [] : (zones as string[]), p_all: zones === null,
    });
    if (rErr) throw rErr;
    riderTickets = (data ?? []) as string[];
  }
  const base = () => applyFilters(scoped(db.from("support_tickets").select(QUEUE_COLUMNS), scope, q.zone), q, viewer.id, riderTickets);

  // Escalated or emergency tickets lead the first page; the rest page by time.
  let urgent: QueueRow[] = [];
  if (!q.cursor) {
    const { data, error } = await base().or("status.eq.escalated,priority.eq.emergency")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(MAX_URGENT);
    if (error) throw error;
    urgent = (data ?? []) as QueueRow[];
  }
  let rest = base().not("status", "eq", "escalated").not("priority", "eq", "emergency");
  if (q.cursor) {
    rest = rest.or(`created_at.lt.${q.cursor.at},and(created_at.eq.${q.cursor.at},id.lt.${q.cursor.id})`);
  }
  const { data, error } = await rest.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1);
  if (error) throw error;
  const page = (data ?? []) as QueueRow[];
  const more = page.length > q.limit;
  const normal = page.slice(0, q.limit);
  const rows = [...urgent.filter(isUrgent), ...normal];

  const [nm, unread, counts] = await Promise.all([
    names(db, rows.flatMap((r) => [r.requester_id, r.assigned_to ?? ""]), rows.map((r) => r.restaurant_id ?? "")),
    unreadCounts(db, rows),
    q.cursor ? Promise.resolve(null) : countsFor(db, scope, q.zone, viewer.id),
  ]);
  const last = normal[normal.length - 1];
  return {
    items: rows.map((r) => toTicketListItem(r, nm, unread.get(r.id) ?? 0, now)),
    nextCursor: more && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
    counts,
  };
}

// ── thread ────────────────────────────────────────────────────────────────

export async function getTicketThread(scope: ManagerScope, id: string): Promise<TicketThread | null> {
  const t = await scopedTicket(scope, id);
  if (!t) return null;
  const supabase = createAdminClient();
  const [{ data: msgs, error }, { data: evs, error: evError }] = await Promise.all([
    supabase.from("support_messages")
      .select("id, author_id, author_role, body, internal, attachments, created_at, profiles(full_name)")
      .eq("ticket_id", id).order("created_at"),
    supabase.from("support_ticket_events")
      .select("id, kind, from_value, to_value, actor_id, reason, internal, created_at")
      .eq("ticket_id", id).order("created_at").limit(500),
  ]);
  if (error) throw error;
  const rows = (msgs ?? []) as ThreadMessageRow[];
  const paths = rows.flatMap((m) => m.attachments ?? []);
  const urls = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 60);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  // A database without 0165 has no event table: the thread still loads.
  type Ev = { id: number; kind: TicketEvent["kind"]; from_value: string | null; to_value: string | null; actor_id: string | null; reason: string | null; internal: boolean; created_at: string };
  const events = evError ? [] : ((evs ?? []) as Ev[]);
  const actorIds = events.map((e) => e.actor_id ?? "");
  const roles = await readByIds<{ id: string; full_name: string | null; role: string }>(
    "profiles", "id, full_name, role", "id", [...new Set([...actorIds, t.requester_id, t.assigned_to ?? ""].filter(Boolean))]
  );
  const who = new Map(roles.map((p) => [p.id, { name: p.full_name?.trim() || "User", role: contractRole(String(p.role)) }]));
  return buildTicketThread(t, rows, urls, {
    requester: { id: t.requester_id, name: who.get(t.requester_id)?.name ?? "User", role: contractRole(t.requester_role) },
    assignee: t.assigned_to ? { id: t.assigned_to, name: who.get(t.assigned_to)?.name ?? "Staff" } : null,
    team: (TEAMS as readonly string[]).includes(t.team ?? "") ? (t.team as Team) : null,
    allowedTransitions: [...(TICKET_TRANSITIONS[t.status as TicketStatusDb] ?? [])],
    events: events.map((e) => ({
      id: Number(e.id), at: e.created_at, kind: e.kind, from: e.from_value, to: e.to_value,
      actor: e.actor_id ? { id: e.actor_id, name: who.get(e.actor_id)?.name ?? "User", role: who.get(e.actor_id)?.role ?? "system" } : null,
      reason: e.reason, internal: e.internal === true,
    })),
  });
}

// ── writes ────────────────────────────────────────────────────────────────

/** Where a requester's app opens a ticket (as support.ts). */
const ROLE_HOME: Record<string, string> = { vendor: "/more/support", rider: "/help", customer: "/support" };
const ROLE_FOR: Record<string, NotificationRole> = { vendor: "vendor", rider: "rider", customer: "customer", manager: "manager", admin: "admin" };
const STATUS_WORDS: Record<string, string> = {
  in_progress: "is being worked on", waiting_on_requester: "is waiting for your reply", resolved: "was resolved", closed: "was closed",
};

/** The requester hears about public activity only — never an internal note. */
function tellRequester(t: QueueRow, title: string, body: string): void {
  const role = ROLE_FOR[t.requester_role];
  if (!role) return;
  deferNotify(() =>
    notifyUser({
      userId: t.requester_id,
      role,
      category: "support",
      title,
      body: body.length > 140 ? `${body.slice(0, 137)}…` : body,
      url: `${ROLE_HOME[t.requester_role] ?? "/support"}/${t.id}`,
      data: { ticketId: t.id },
    })
  );
}

function replayedOf(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { replayed?: unknown }).replayed === true;
}

/**
 * A reply or an internal note, with up to four files uploaded first (removed
 * again if the RPC refuses). Files go to `support-attachments/<ticket>/<uuid>.<ext>`.
 */
export async function opsTicketMessage(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  body: string,
  internal: boolean,
  clientActionId: string,
  files: { bytes: Uint8Array; mime: string; ext: string }[] = []
): Promise<OpsResult> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const supabase = createAdminClient();
  const paths: string[] = [];
  for (const f of files) {
    const path = `${id}/${randomUUID()}.${f.ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, f.bytes, { contentType: f.mime, upsert: false });
    if (error) {
      if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
      return { ok: false, status: 500, error: "upload_failed" };
    }
    paths.push(path);
  }
  const { data, error } = await supabase.rpc("ops_add_ticket_message", {
    p_actor: actor.id, p_ticket: id, p_body: body, p_internal: internal, p_attachments: paths, p_client_action_id: clientActionId,
  });
  if (error) {
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    return mapSupportRpcError(error);
  }
  if (!replayedOf(data) && !internal) tellRequester(t, `Reply on ticket #${Number(t.number)}`, body);
  return { ok: true };
}

export async function opsTicketStatus(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  status: string,
  resolution: string | null,
  clientActionId: string,
  reason: string | null = null
): Promise<OpsResult> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const { data, error } = await createAdminClient().rpc("ops_set_ticket_status", {
    p_actor: actor.id, p_ticket: id, p_status: status, p_resolution: resolution, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapSupportRpcError(error);
  if (!replayedOf(data)) {
    const words = STATUS_WORDS[status] ?? "was updated";
    tellRequester(
      t,
      `Ticket #${Number(t.number)} ${words}`,
      status === "resolved" ? `Deligro marked your ticket resolved: ${resolution ?? ""}` : `Your ticket ${words}.`
    );
  }
  return { ok: true };
}

export async function opsAssignTicket(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  assigneeId: string | null,
  team: Team | null,
  clientActionId: string
): Promise<OpsResult> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const { data, error } = await createAdminClient().rpc("ops_assign_ticket", {
    p_actor: actor.id, p_ticket: id, p_assignee: assigneeId, p_team: team, p_client_action_id: clientActionId,
  });
  if (error) return mapSupportRpcError(error);
  if (!replayedOf(data) && assigneeId && assigneeId !== actor.id) {
    deferNotify(() => notifyStaff(
      { zoneId: t.zone_id, kind: "ticket_activity", userIds: [assigneeId] },
      { title: `Ticket #${Number(t.number)} assigned to you`, body: `${categoryLabel(t.category)} ticket.` },
      { url: `/more/tickets/${t.id}`, ticketId: t.id }
    ));
  }
  return { ok: true };
}

export async function opsTicketPriority(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  priority: string,
  reason: string,
  clientActionId: string
): Promise<OpsResult> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const { data, error } = await createAdminClient().rpc("ops_set_ticket_priority", {
    p_actor: actor.id, p_ticket: id, p_priority: priority, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapSupportRpcError(error);
  if (!replayedOf(data) && priority !== "normal") {
    deferNotify(() => raiseEventAlert(alertFor.ticket({
      id: t.id, number: Number(t.number), category: t.category, zoneId: t.zone_id, priority, status: t.status,
      createdAt: t.created_at, firstResponseAt: t.first_response_at,
    }, Number.POSITIVE_INFINITY, new Date())));
  }
  return { ok: true };
}

export async function opsEscalateTicket(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  reason: string,
  clientActionId: string
): Promise<OpsResult & { level?: number }> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const before = t.escalation_level ?? 0;
  const { data, error } = await createAdminClient().rpc("ops_escalate_ticket", {
    p_actor: actor.id, p_ticket: id, p_reason: reason, p_client_action_id: clientActionId,
  });
  if (error) return mapSupportRpcError(error);
  const level = Number(data);
  if (level > before) {
    // Level 1: the zone's support managers. Level 2 and up: every admin as well.
    deferNotify(() => notifyTicketEscalated(t.id, level));
  }
  return { ok: true, level };
}

// ── assignees, metrics ────────────────────────────────────────────────────

export async function listAssignees(scope: ManagerScope, zone: string | null): Promise<{ id: string; name: string; role: "manager" | "admin"; openAssigned: number }[]> {
  const db = createAdminClient();
  const zones = scopeZoneIds(zone ? narrowScope(scope, zone) : scope);
  const { data: admins, error: aErr } = await db.from("profiles").select("id, full_name").eq("role", "admin");
  if (aErr) throw aErr;
  let managerIds: string[] = [];
  if (zones === null) {
    const { data, error } = await db.from("profiles").select("id").eq("role", "manager");
    if (error) throw error;
    managerIds = ((data ?? []) as { id: string }[]).map((m) => m.id);
  } else if (zones.length > 0) {
    const { data, error } = await db.from("staff_zones").select("user_id").in("zone_id", zones as string[]);
    if (error) throw error;
    managerIds = [...new Set(((data ?? []) as { user_id: string }[]).map((s) => s.user_id))];
  }
  const people = await readByIds<{ id: string; full_name: string | null; role: string }>("profiles", "id, full_name, role", "id", managerIds);
  const { getFeatures } = await import("@/lib/features/flags.server");
  const managers = [];
  for (const p of people.filter((x) => String(x.role) === "manager")) {
    if ((await getFeatures("manager", p.id))["manager.support.manage"]) managers.push(p);
  }
  const staff = [
    ...((admins ?? []) as { id: string; full_name: string | null }[]).map((a) => ({ id: a.id, name: a.full_name?.trim() || "Admin", role: "admin" as const })),
    ...managers.map((m) => ({ id: m.id, name: m.full_name?.trim() || "Manager", role: "manager" as const })),
  ];
  const open = await readByIds<{ assigned_to: string }>("support_tickets", "assigned_to", "assigned_to", staff.map((s) => s.id), {
    status: ["open", "in_progress", "waiting_on_requester", "escalated"],
  });
  const load = new Map<string, number>();
  for (const o of open) load.set(o.assigned_to, (load.get(o.assigned_to) ?? 0) + 1);
  return staff.map((s) => ({ ...s, openAssigned: load.get(s.id) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
}

type Share = { id: string; count: number; share: number };

export async function ticketMetrics(scope: ManagerScope, range: { from: string; to: string }, zone: string | null) {
  const db = createAdminClient();
  const zones = scopeZoneIds(zone ? narrowScope(scope, zone) : scope);
  const sla = effectiveRule(await loadAlertRules().catch(() => []), "complaint_high_priority", zone).threshold ?? 30;
  const { data, error } = await db.rpc("ops_ticket_metrics", {
    p_zone_ids: zones === null ? null : (zones as string[]),
    p_all: zones === null,
    p_from: range.from,
    p_to: range.to,
    p_sla_minutes: sla,
  });
  if (error) throw error;
  const m = data as {
    created: number; resolved: number; reopened: number; openOverSla: number;
    firstResponse: unknown; resolution: unknown;
    byStatus: Record<string, number>; byPriority: Record<string, number>; byRequesterRole: Record<string, number>;
    recurring: { categories: { key: string; count: number; share: number }[]; vendors: Share[]; riders: Share[]; zones: Share[]; orders: { id: string; count: number }[] };
    daily: { date: string; created: number; resolved: number }[];
  };
  const [shops, people, codes, zoneRows] = await Promise.all([
    readByIds<{ id: string; name: string | null }>("restaurants", "id, name", "id", m.recurring.vendors.map((v) => v.id)),
    readByIds<{ id: string; full_name: string | null }>("profiles", "id, full_name", "id", m.recurring.riders.map((r) => r.id)),
    readByIds<{ driver_id: string; rider_code: string | null }>("rider_profiles", "driver_id, rider_code", "driver_id", m.recurring.riders.map((r) => r.id)).catch(() => []),
    readByIds<{ id: string; name: string }>("delivery_zones", "id, name", "id", m.recurring.zones.map((z) => z.id)),
  ]);
  const shopName = new Map(shops.map((s) => [s.id, s.name?.trim() || "Shop"]));
  const personName = new Map(people.map((p) => [p.id, p.full_name?.trim() || "Rider"]));
  const riderCode = new Map(codes.map((c) => [c.driver_id, c.rider_code]));
  const zoneName = new Map(zoneRows.map((z) => [z.id, z.name]));
  const byRole: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.byRequesterRole ?? {})) byRole[contractRole(k)] = (byRole[contractRole(k)] ?? 0) + Number(v);
  return {
    range: { from: range.from, to: range.to },
    created: Number(m.created), resolved: Number(m.resolved), reopened: Number(m.reopened), openOverSla: Number(m.openOverSla),
    firstResponse: m.firstResponse, resolution: m.resolution,
    byStatus: m.byStatus ?? {}, byPriority: m.byPriority ?? {}, byRequesterRole: byRole,
    recurring: {
      categories: m.recurring.categories.map((c) => ({ key: c.key, label: categoryLabel(c.key), count: Number(c.count), share: Number(c.share) })),
      vendors: m.recurring.vendors.map((v) => ({ id: v.id, name: shopName.get(v.id) ?? "Shop", count: Number(v.count), share: Number(v.share) })),
      riders: m.recurring.riders.map((r) => ({ id: r.id, name: personName.get(r.id) ?? "Rider", code: riderCode.get(r.id) ?? null, count: Number(r.count), share: Number(r.share) })),
      zones: m.recurring.zones.map((z) => ({ id: z.id, name: zoneName.get(z.id) ?? "Zone", count: Number(z.count), share: Number(z.share) })),
      orders: m.recurring.orders.map((o) => ({ id: o.id, code: orderShortCode(o.id), count: Number(o.count) })),
    },
    daily: m.daily,
    generatedAt: new Date().toISOString(),
  };
}

/** Today in IST and the last 30 days — the metrics screen's default range. */
export function defaultMetricsRange(now: Date): { from: string; to: string } {
  const to = istDayKey(now);
  return { from: addDays(to, -29), to };
}

export type { TicketListItem, TicketCounts };
export { TICKET_COLUMNS };
