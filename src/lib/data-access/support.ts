import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/data-access/schema-probe";
import { notifyUser, type NotificationRole } from "@/lib/notifications/notify-user";
import type { TicketInput, TicketStatus } from "@/lib/vendor/growth-input";

/**
 * Support tickets (requirements §12, 0064 — the shared rider/vendor/manager
 * tables). Requesters read their own tickets through their own client (RLS
 * hides internal notes); every write uses the service role after the route
 * has checked who is asking. Attachments live in the private
 * `support-attachments` bucket under `<uploader id>/`, uploaded with a signed
 * upload URL and read back through short-lived signed URLs.
 */
export class SupportNotMigratedError extends Error {
  constructor() {
    super("needs_migration");
  }
}

const BUCKET = "support-attachments";
const SIGNED_SECONDS = 60 * 10;

export interface TicketSummary {
  id: string;
  number: number;
  category: string;
  subject: string;
  status: TicketStatus;
  priority: string;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
  requesterRole?: string;
  requesterName?: string;
}

export interface TicketMessage {
  id: string;
  body: string;
  fromYou: boolean;
  authorRole: string;
  internal: boolean;
  attachments: { path: string; url: string | null }[];
  createdAt: string;
}

const TICKET_COLUMNS = "id, number, category, subject, status, priority, order_id, created_at, updated_at, requester_role";

function mapTicket(r: Record<string, unknown>): TicketSummary {
  return {
    id: String(r.id),
    number: Number(r.number),
    category: String(r.category),
    subject: String(r.subject),
    status: r.status as TicketStatus,
    priority: String(r.priority ?? "normal"),
    orderId: (r.order_id as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    requesterRole: (r.requester_role as string | undefined) ?? undefined,
  };
}

function rethrow(error: { code?: string }): never {
  if (isMissingTable(error)) throw new SupportNotMigratedError();
  throw error;
}

async function signed(paths: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const { data } = await createAdminClient().storage.from(BUCKET).createSignedUrls(paths, SIGNED_SECONDS);
  for (const d of data ?? []) out.set(d.path ?? "", d.signedUrl ?? null);
  return out;
}

async function mapMessages(rows: Record<string, unknown>[], viewerId: string): Promise<TicketMessage[]> {
  const urls = await signed(rows.flatMap((m) => (m.attachments as string[] | null) ?? []));
  return rows.map((m) => ({
    id: String(m.id),
    body: String(m.body),
    fromYou: m.author_id === viewerId,
    authorRole: String(m.author_role),
    internal: m.internal === true,
    attachments: ((m.attachments as string[] | null) ?? []).map((p) => ({ path: p, url: urls.get(p) ?? null })),
    createdAt: String(m.created_at),
  }));
}

// ---- Requester ----

export async function listMyTickets(userId: string): Promise<TicketSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("requester_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) rethrow(error);
  return (data ?? []).map((r) => mapTicket(r as Record<string, unknown>));
}

/** A signed upload URL for one photo in the uploader's own folder. */
export async function attachmentUploadUrl(userId: string, ext: "jpg" | "png"): Promise<{ path: string; url: string; token: string }> {
  const path = `${userId}/${randomUUID()}.${ext}`;
  const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("upload_url_failed");
  return { path, url: data.signedUrl, token: data.token };
}

export async function createTicket(userId: string, role: NotificationRole, input: TicketInput): Promise<TicketSummary> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("support_tickets")
    .insert({
      requester_id: userId,
      requester_role: role,
      category: input.category,
      subject: input.subject,
      order_id: input.orderId,
    })
    .select(TICKET_COLUMNS)
    .single();
  if (error) rethrow(error);
  const { error: msgError } = await admin.from("support_messages").insert({
    ticket_id: data.id,
    author_id: userId,
    author_role: role,
    body: input.body,
    attachments: input.attachments,
  });
  if (msgError) throw msgError;
  return mapTicket(data as Record<string, unknown>);
}

/** The requester's ticket and its non-internal messages; null when not theirs. */
export async function getMyTicket(userId: string, id: string): Promise<{ ticket: TicketSummary; messages: TicketMessage[] } | null> {
  const supabase = await createClient();
  const { data: t, error } = await supabase.from("support_tickets").select(TICKET_COLUMNS).eq("id", id).eq("requester_id", userId).maybeSingle();
  if (error) rethrow(error);
  if (!t) return null;
  const { data: msgs, error: mErr } = await supabase
    .from("support_messages")
    .select("id, body, author_id, author_role, internal, attachments, created_at")
    .eq("ticket_id", id)
    .eq("internal", false)
    .order("created_at");
  if (mErr) throw mErr;
  return { ticket: mapTicket(t as Record<string, unknown>), messages: await mapMessages((msgs ?? []) as Record<string, unknown>[], userId) };
}

/** The requester replies. A resolved / closed ticket reopens. False when not theirs. */
export async function replyToMyTicket(
  userId: string,
  role: NotificationRole,
  id: string,
  message: { body: string; attachments: string[] }
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: t, error } = await admin.from("support_tickets").select("id, status").eq("id", id).eq("requester_id", userId).maybeSingle();
  if (error) rethrow(error);
  if (!t) return false;
  const { error: mErr } = await admin.from("support_messages").insert({
    ticket_id: id,
    author_id: userId,
    author_role: role,
    body: message.body,
    attachments: message.attachments,
  });
  if (mErr) throw mErr;
  await admin
    .from("support_tickets")
    .update({
      updated_at: new Date().toISOString(),
      ...(t.status === "resolved" || t.status === "closed" || t.status === "waiting_on_requester" ? { status: "open", resolved_at: null } : {}),
    })
    .eq("id", id);
  return true;
}

// ---- Admin ----

export async function listAllTickets(filter: { status?: TicketStatus; role?: string } = {}): Promise<TicketSummary[]> {
  const admin = createAdminClient();
  let q = admin
    .from("support_tickets")
    .select(`${TICKET_COLUMNS}, requester:profiles!support_tickets_requester_id_fkey(full_name)`)
    .order("updated_at", { ascending: false })
    .limit(300);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.role) q = q.eq("requester_role", filter.role);
  const { data, error } = await q;
  if (error) rethrow(error);
  return (data ?? []).map((r) => {
    const req = (r as Record<string, unknown>).requester as { full_name?: string | null } | { full_name?: string | null }[] | null;
    return { ...mapTicket(r as Record<string, unknown>), requesterName: (Array.isArray(req) ? req[0]?.full_name : req?.full_name) ?? "—" };
  });
}

export async function getTicketForAdmin(id: string, adminId: string) {
  const admin = createAdminClient();
  const { data: t, error } = await admin
    .from("support_tickets")
    .select(`${TICKET_COLUMNS}, requester_id, requester:profiles!support_tickets_requester_id_fkey(full_name)`)
    .eq("id", id)
    .maybeSingle();
  if (error) rethrow(error);
  if (!t) return null;
  const { data: msgs, error: mErr } = await admin
    .from("support_messages")
    .select("id, body, author_id, author_role, internal, attachments, created_at")
    .eq("ticket_id", id)
    .order("created_at");
  if (mErr) throw mErr;
  const req = (t as Record<string, unknown>).requester as { full_name?: string | null } | { full_name?: string | null }[] | null;
  return {
    ticket: { ...mapTicket(t as Record<string, unknown>), requesterName: (Array.isArray(req) ? req[0]?.full_name : req?.full_name) ?? "—" },
    requesterId: String((t as Record<string, unknown>).requester_id),
    messages: await mapMessages((msgs ?? []) as Record<string, unknown>[], adminId),
  };
}

const ROLE_HOME: Record<string, string> = { vendor: "/more/support", rider: "/help", customer: "/support" };

/** An admin answers (or leaves an internal note) and may move the status on. */
export async function adminReply(
  id: string,
  adminId: string,
  message: { body: string; attachments: string[]; internal: boolean },
  status?: TicketStatus
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: t, error } = await admin.from("support_tickets").select("id, requester_id, requester_role, subject, number").eq("id", id).maybeSingle();
  if (error) rethrow(error);
  if (!t) return false;
  const { error: mErr } = await admin.from("support_messages").insert({
    ticket_id: id,
    author_id: adminId,
    author_role: "admin",
    body: message.body,
    attachments: message.attachments,
    internal: message.internal,
  });
  if (mErr) throw mErr;
  await setTicketStatus(id, status ?? (message.internal ? undefined : "waiting_on_requester"), adminId, { notify: false });
  if (!message.internal) {
    await notifyUser({
      userId: t.requester_id as string,
      role: (t.requester_role as NotificationRole) ?? "vendor",
      category: "support",
      title: `Reply on ticket #${t.number}`,
      body: message.body.length > 140 ? `${message.body.slice(0, 137)}…` : message.body,
      url: `${ROLE_HOME[String(t.requester_role)] ?? "/support"}/${id}`,
      data: { ticketId: id },
    });
  }
  return true;
}

export async function setTicketStatus(
  id: string,
  status: TicketStatus | undefined,
  adminId: string,
  opts: { notify?: boolean } = {}
): Promise<void> {
  if (!status) return;
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("support_tickets")
    .update({
      status,
      updated_at: new Date().toISOString(),
      resolved_at: status === "resolved" || status === "closed" ? new Date().toISOString() : null,
      assigned_to: adminId,
    })
    .eq("id", id)
    .select("requester_id, requester_role, number")
    .maybeSingle();
  // Every status change reaches the requester (requirements §12.6).
  if (t && opts.notify !== false) {
    const words: Record<TicketStatus, [string, string]> = {
      open: ["reopened", "Your ticket is open again."],
      in_progress: ["is being looked at", "Deligro support is working on it."],
      waiting_on_requester: ["needs your reply", "Deligro needs a little more from you."],
      resolved: ["is resolved", "Deligro marked your ticket resolved. Reply if you still need help."],
      closed: ["is closed", "Your ticket was closed."],
    };
    await notifyUser({
      userId: t.requester_id as string,
      role: (t.requester_role as NotificationRole) ?? "vendor",
      category: "support",
      title: `Ticket #${t.number} ${words[status][0]}`,
      body: words[status][1],
      url: `${ROLE_HOME[String(t.requester_role)] ?? "/support"}/${id}`,
      data: { ticketId: id },
    });
  }
}
