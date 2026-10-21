import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeZoneIds, type ManagerScope } from "@/lib/auth/manager-scope";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyUser, type NotificationRole } from "@/lib/notifications/notify-user";
import { mapVendorRpcError } from "@/lib/ops/vendor-actions";
import { TICKET_COLUMNS, toTicketSummary, type TicketRow, type TicketSummary } from "@/lib/ops/vendor-contract";
import type { OpsResult } from "@/lib/ops/order-actions";
import type { OpsActor } from "@/lib/data-access/manager-ops-actions";

/**
 * The generic ticket thread for the Manager app (§4.15 now; Phase 8 adds
 * assignment, filters and metrics on top of these rather than a second copy).
 * Built on the shared tables the Partner branch's 0064 created and its
 * support.ts writes; manager writes go through the 0145 RPCs so each reply and
 * status change is audited with the actor's zone checked in the database.
 * Tickets are seen through their zone (0143); a ticket with no zone is admin-only.
 */

export interface TicketThread {
  ticket: TicketSummary & {
    restaurant: { id: string; name: string } | null;
    zoneId: string | null;
    escalationLevel: number;
    resolution: string | null;
    firstResponseAt: string | null;
    resolvedAt: string | null;
  };
  messages: {
    id: string;
    author: { id: string; name: string; role: string };
    body: string;
    internal: boolean;
    attachments: { name: string; url: string }[];
    at: string;
  }[];
}

const BUCKET = "support-attachments";
const NOT_FOUND: OpsResult = { ok: false, status: 404, error: "not_found" };

type ThreadRow = TicketRow & {
  requester_id: string;
  restaurant_id: string | null;
  zone_id: string | null;
  escalation_level: number | null;
  resolution: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  restaurants: { name: string | null } | { name: string | null }[] | null;
};

async function scopedTicket(scope: ManagerScope, id: string): Promise<ThreadRow | null> {
  let query = createAdminClient()
    .from("support_tickets")
    .select(`${TICKET_COLUMNS}, requester_id, restaurant_id, zone_id, escalation_level, resolution, first_response_at, resolved_at, restaurants(name)`)
    .eq("id", id);
  // A ticket with no zone is admin-only: `in` never matches a null zone.
  const zones = scopeZoneIds(scope);
  if (zones) query = query.in("zone_id", zones as string[]);
  const { data, error } = await query.maybeSingle<ThreadRow>();
  if (error) throw error;
  return data ?? null;
}

export async function getTicketThread(scope: ManagerScope, id: string): Promise<TicketThread | null> {
  const t = await scopedTicket(scope, id);
  if (!t) return null;
  const supabase = createAdminClient();
  const { data: msgs, error } = await supabase
    .from("support_messages")
    .select("id, author_id, author_role, body, internal, attachments, created_at, profiles(full_name)")
    .eq("ticket_id", id)
    .order("created_at");
  if (error) throw error;
  type MsgRow = {
    id: string; author_id: string; author_role: string; body: string; internal: boolean; attachments: string[] | null;
    created_at: string; profiles: { full_name: string | null } | { full_name: string | null }[] | null;
  };
  const rows = (msgs ?? []) as MsgRow[];
  const paths = rows.flatMap((m) => m.attachments ?? []);
  const urls = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 60);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  const shop = Array.isArray(t.restaurants) ? t.restaurants[0] : t.restaurants;
  return {
    ticket: {
      ...toTicketSummary(t),
      restaurant: t.restaurant_id ? { id: t.restaurant_id, name: shop?.name?.trim() || "Shop" } : null,
      zoneId: t.zone_id,
      escalationLevel: t.escalation_level ?? 0,
      resolution: t.resolution,
      firstResponseAt: t.first_response_at,
      resolvedAt: t.resolved_at,
    },
    messages: rows.map((m) => {
      const author = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
      return {
        id: m.id,
        author: { id: m.author_id, name: author?.full_name?.trim() || "User", role: m.author_role },
        body: m.body,
        internal: m.internal === true,
        attachments: (m.attachments ?? [])
          .filter((p) => urls.has(p))
          .map((p) => ({ name: p.split("/").pop() ?? "attachment", url: urls.get(p)! })),
        at: m.created_at,
      };
    }),
  };
}

/** Where a requester's app opens a ticket (as support.ts). */
const ROLE_HOME: Record<string, string> = { vendor: "/more/support", rider: "/help", customer: "/support" };
const ROLE_FOR: Record<string, NotificationRole> = { vendor: "vendor", rider: "rider", customer: "customer", manager: "manager", admin: "admin" };

async function alreadyDone(actorId: string, clientActionId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("ops_audit_log")
    .select("actor_id")
    .eq("client_action_id", clientActionId)
    .maybeSingle();
  return !!data && (data as { actor_id: string }).actor_id === actorId;
}

function tellRequester(t: ThreadRow, title: string, body: string): void {
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

export async function opsTicketMessage(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  body: string,
  internal: boolean,
  clientActionId: string
): Promise<OpsResult> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await createAdminClient().rpc("ops_add_ticket_message", {
    p_actor: actor.id,
    p_ticket: id,
    p_body: body,
    p_internal: internal,
    p_client_action_id: clientActionId,
  });
  if (error) return mapVendorRpcError(error);
  if (!replay && !internal) tellRequester(t, `Reply on ticket #${Number(t.number)}`, body);
  return { ok: true };
}

export async function opsTicketStatus(
  actor: OpsActor,
  scope: ManagerScope,
  id: string,
  status: string,
  resolution: string | null,
  clientActionId: string
): Promise<OpsResult> {
  const t = await scopedTicket(scope, id);
  if (!t) return NOT_FOUND;
  const replay = await alreadyDone(actor.id, clientActionId);
  const { error } = await createAdminClient().rpc("ops_set_ticket_status", {
    p_actor: actor.id,
    p_ticket: id,
    p_status: status,
    p_resolution: resolution,
    p_client_action_id: clientActionId,
  });
  if (error) return mapVendorRpcError(error);
  if (!replay && (status === "resolved" || status === "closed")) {
    tellRequester(
      t,
      `Ticket #${Number(t.number)} ${status}`,
      status === "resolved" ? `Deligro marked your ticket resolved: ${resolution ?? ""}` : "Your ticket was closed."
    );
  }
  return { ok: true };
}
