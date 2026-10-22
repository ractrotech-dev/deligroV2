import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { shortOrderId } from "@/lib/utils/order-map";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { notifyUser, type NotificationRole } from "@/lib/notifications/notify-user";
import { stopOpsSosRing } from "@/lib/notifications/order-events";
import {
  removeAttachments,
  signAttachments,
  uploadAttachments,
  validateAttachments,
} from "@/lib/data-access/support-attachments";
import { raiseSos } from "@/lib/data-access/sos";
import {
  categoryLabel,
  defaultPriority,
  isSafetyCategory,
  isUuid,
  locationLink,
  parseMessage,
  parseNewTicket,
  statusLabel,
  type AttachmentError,
  type TicketFilter,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/support/rules";

/**
 * Support tickets — the shared rider / vendor / manager tables (0064 / 0087 /
 * 0143). The rules (categories, priorities, parsers) are `lib/support/rules.ts`;
 * SOS is `sos.ts`; photos are `support-attachments.ts`.
 *
 * ## Authorization
 *
 * Everything here runs on the service-role client, so the caller has already
 * decided who is asking:
 *
 *   * requester functions (`createTicket`, `listMyTickets`, `getMyTicket`,
 *     `replyToMyTicket`) take the requester's id from the session behind
 *     `requireRiderApi()` — never from a body — and every read is filtered by
 *     it. A ticket that is not theirs reads exactly like one that does not
 *     exist (null / not_found), and no signed URL is minted for it. Internal
 *     notes are filtered out here as well as by RLS.
 *   * staff functions (`listTicketsForStaff`, `getTicketForStaff`,
 *     `staffReply`, `setTicketStatus`, `assignTicketToSelf`,
 *     `listOpenEmergencies`, `listTicketsOfRequester`) run behind
 *     `requireRole("admin")` (the support desk) or `requireRole(["manager",
 *     "admin"])` (the manager board's read-only view).
 *
 * The Partner app's `support.ts` (feat/vendor-app) has requester and admin
 * functions of the same names over the same tables; this file is the rider
 * side's superset — merge the two deliberately (AGENTS.md) rather than keep
 * both.
 *
 * Before 0087 (or 0064) every write throws `SupportNotMigratedError` (503
 * migration_pending); requester reads do too, so the app can say so.
 */

export class SupportNotMigratedError extends RiderSchemaPendingError {
  constructor() {
    super("migration_pending: support tickets (0087) are not applied");
    this.name = "SupportNotMigratedError";
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;
type PgError = { code?: string; message?: string };

function fail(error: PgError): never {
  if (isMissingTable(error) || isMissingColumn(error)) throw new SupportNotMigratedError();
  throw error;
}

export interface SupportUser {
  id: string;
  role: NotificationRole;
}

export interface StaffUser {
  id: string;
  role: "admin" | "manager";
}

export interface TicketSummary {
  id: string;
  number: number;
  category: string;
  categoryLabel: string;
  priority: TicketPriority;
  subject: string;
  status: TicketStatus;
  statusLabel: string;
  orderId: string | null;
  orderCode: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface TicketAttachment {
  url: string | null;
}

export interface TicketMessage {
  id: string;
  body: string;
  /** Written by Deligro staff (admin or manager), not the requester. */
  fromStaff: boolean;
  authorRole: string;
  attachments: TicketAttachment[];
  createdAt: string;
}

export interface TicketThread {
  ticket: TicketSummary & { lat: number | null; lng: number | null; locationUrl: string | null };
  messages: TicketMessage[];
}

interface TicketRow {
  id: string;
  number: number;
  requester_id: string;
  requester_role: string;
  category: string;
  priority: TicketPriority;
  subject: string;
  status: TicketStatus;
  order_id: string | null;
  lat: number | null;
  lng: number | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface MessageRow {
  id: string;
  ticket_id: string;
  author_id: string;
  author_role: string;
  body: string;
  attachments: string[] | null;
  internal: boolean;
  created_at: string;
}

const TICKET_COLUMNS =
  "id, number, requester_id, requester_role, category, priority, subject, status, order_id, lat, lng, assigned_to, created_at, updated_at, resolved_at";
const MESSAGE_COLUMNS = "id, ticket_id, author_id, author_role, body, attachments, internal, created_at";
const STAFF_ROLES = new Set(["admin", "manager"]);
const OPEN_STATUSES: TicketStatus[] = ["open", "in_progress", "waiting_on_requester", "escalated"];

const orderCode = (id: string | null) => (id ? `#${shortOrderId(id)}` : null);

function summary(r: TicketRow): TicketSummary {
  return {
    id: r.id,
    number: Number(r.number),
    category: r.category,
    categoryLabel: categoryLabel(r.category),
    priority: r.priority,
    subject: r.subject,
    status: r.status,
    statusLabel: statusLabel(r.status),
    orderId: r.order_id,
    orderCode: orderCode(r.order_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

async function readTicket(supabase: AdminClient, id: string, requesterId?: string): Promise<TicketRow | null> {
  if (!isUuid(id)) return null;
  let q = supabase.from("support_tickets").select(TICKET_COLUMNS).eq("id", id);
  if (requesterId) q = q.eq("requester_id", requesterId);
  const { data, error } = await q.maybeSingle().overrideTypes<TicketRow>();
  if (error) fail(error);
  return data;
}

async function readMessages(supabase: AdminClient, ticketId: string, includeInternal: boolean): Promise<MessageRow[]> {
  let q = supabase.from("support_messages").select(MESSAGE_COLUMNS).eq("ticket_id", ticketId);
  if (!includeInternal) q = q.eq("internal", false);
  const { data, error } = await q.order("created_at", { ascending: true }).overrideTypes<MessageRow[]>();
  if (error) fail(error);
  return data ?? [];
}

/** Does this rider hold (or did they hold) the delivery for this order? */
async function riderOwnsOrder(supabase: AdminClient, riderId: string, orderId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("deliveries")
    .select("id")
    .eq("order_id", orderId)
    .eq("driver_id", riderId)
    .limit(1)
    .overrideTypes<{ id: string }[]>();
  if (error) return false;
  return (data ?? []).length > 0;
}

/** Where a tap on a ticket push goes, per requester app. */
function ticketUrl(role: string, id: string): string {
  switch (role) {
    case "rider":
      return `/help/tickets/${id}`;
    case "vendor":
      return `/more/support/${id}`;
    default:
      return `/support/${id}`;
  }
}

const asRole = (role: string): NotificationRole =>
  (["vendor", "rider", "manager", "customer", "admin"].includes(role) ? role : "customer") as NotificationRole;

// ---------------------------------------------------------------------------
// requester
// ---------------------------------------------------------------------------

export type CreateTicketResult =
  | { ok: true; id: string; number: number; priority: TicketPriority }
  | { ok: false; error: "invalid_category" | "invalid_subject" | "invalid_message" | "invalid_order" | AttachmentError };

/**
 * A requester opens a ticket with its first message and up to four photos.
 * A rider may link an order only if they were its rider (`invalid_order`
 * otherwise). An emergency category (accident or a safety report) is filed
 * through the SOS path instead, so it is deduplicated and rings ops exactly
 * like the SOS button.
 */
export async function createTicket(
  user: SupportUser,
  input: {
    category: unknown;
    subject?: unknown;
    message: unknown;
    orderId?: unknown;
    attachments?: File[];
    lat?: unknown;
    lng?: unknown;
  }
): Promise<CreateTicketResult> {
  const parsed = parseNewTicket(input);
  if (!parsed.ok) return parsed;
  const t = parsed.value;
  const files = input.attachments ?? [];
  const bad = await validateAttachments(files);
  if (bad) return { ok: false, error: bad };

  const supabase = createAdminClient();
  if (t.orderId && !(await riderOwnsOrder(supabase, user.id, t.orderId))) return { ok: false, error: "invalid_order" };

  const priority = defaultPriority(t.category);
  if (priority === "emergency" && user.role === "rider") {
    const r = await raiseSos(user.id, {
      kind: isSafetyCategory(t.category) ? t.category : "alert",
      lat: t.lat,
      lng: t.lng,
      note: t.message,
      orderId: t.orderId,
      attachments: files,
      subject: t.subject,
    });
    if (!r.ok) return r;
    return { ok: true, id: r.ticketId, number: r.number, priority: "emergency" };
  }

  const paths = await uploadAttachments(user.id, files, supabase);
  try {
    const { data, error } = await supabase
      .from("support_tickets")
      .insert({
        requester_id: user.id,
        requester_role: user.role,
        category: t.category,
        priority,
        subject: t.subject,
        order_id: t.orderId,
        lat: t.lat,
        lng: t.lng,
      })
      .select("id, number")
      .single()
      .overrideTypes<{ id: string; number: number }>();
    if (error) fail(error);
    const { error: msgError } = await supabase.from("support_messages").insert({
      ticket_id: data.id,
      author_id: user.id,
      author_role: user.role,
      body: t.message,
      attachments: paths,
    });
    if (msgError) fail(msgError);
    return { ok: true, id: data.id, number: Number(data.number), priority };
  } catch (e) {
    await removeAttachments(paths, supabase);
    throw e;
  }
}

/** The requester's tickets, newest activity first. */
export async function listMyTickets(userId: string): Promise<TicketSummary[]> {
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("requester_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100)
    .overrideTypes<TicketRow[]>();
  if (error) fail(error);
  return (data ?? []).map(summary);
}

/**
 * The requester's ticket and its public thread, with 10-minute signed photo
 * URLs. Null when it is not theirs — and then nothing is signed.
 */
export async function getMyTicket(userId: string, id: string): Promise<TicketThread | null> {
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id, userId);
  if (!row || row.requester_id !== userId) return null;
  const messages = await readMessages(supabase, row.id, false);
  const urls = await signAttachments(messages.flatMap((m) => m.attachments ?? []), supabase);
  return {
    ticket: { ...summary(row), lat: row.lat, lng: row.lng, locationUrl: locationLink(row.lat, row.lng) },
    messages: messages
      .filter((m) => !m.internal)
      .map((m) => ({
        id: m.id,
        body: m.body,
        fromStaff: m.author_id !== userId && STAFF_ROLES.has(m.author_role),
        authorRole: m.author_role,
        attachments: (m.attachments ?? []).map((p) => ({ url: urls.get(p) ?? null })),
        createdAt: m.created_at,
      })),
  };
}

export type ReplyResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "invalid_message" | AttachmentError };

/**
 * The requester replies (with up to four photos). A ticket waiting on them,
 * resolved or closed opens again — they still need help.
 */
export async function replyToMyTicket(
  user: SupportUser,
  id: string,
  input: { message: unknown; attachments?: File[] }
): Promise<ReplyResult> {
  const message = parseMessage(input.message);
  if (!message.ok) return message;
  const files = input.attachments ?? [];
  const bad = await validateAttachments(files);
  if (bad) return { ok: false, error: bad };

  const supabase = createAdminClient();
  const row = await readTicket(supabase, id, user.id);
  if (!row || row.requester_id !== user.id) return { ok: false, error: "not_found" };

  const paths = await uploadAttachments(user.id, files, supabase);
  const { data, error } = await supabase
    .from("support_messages")
    .insert({ ticket_id: row.id, author_id: user.id, author_role: user.role, body: message.value, attachments: paths })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();
  if (error) {
    await removeAttachments(paths, supabase);
    fail(error);
  }
  const reopen = row.status === "waiting_on_requester" || row.status === "resolved" || row.status === "closed";
  await supabase
    .from("support_tickets")
    .update({ updated_at: new Date().toISOString(), ...(reopen ? { status: "open", resolved_at: null } : {}) })
    .eq("id", row.id);
  return { ok: true, id: data.id };
}

// ---------------------------------------------------------------------------
// linked tickets (pickup reports, cash disputes)
// ---------------------------------------------------------------------------

/**
 * A ticket the server files on someone's behalf: a pickup report (Phase 2
 * exception, ruling P2-R11) or — for Phase 5 — a cash dispute (category
 * `cash_reconciliation`, `cashDisputeId`). Best effort: returns null and
 * reports, never throws into the action that caused it.
 */
export async function createLinkedTicket(input: {
  requesterId: string;
  role: NotificationRole;
  category: string;
  priority?: TicketPriority;
  subject: string;
  body: string;
  orderId?: string | null;
  cashDisputeId?: string | null;
}): Promise<{ id: string; number: number } | null> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("support_tickets")
      .insert({
        requester_id: input.requesterId,
        requester_role: input.role,
        category: input.category,
        priority: input.priority ?? defaultPriority(input.category),
        subject: input.subject.slice(0, 200),
        order_id: input.orderId ?? null,
        cash_dispute_id: input.cashDisputeId ?? null,
      })
      .select("id, number")
      .single()
      .overrideTypes<{ id: string; number: number }>();
    if (error) {
      if (!isMissingTable(error)) throw error;
      return null;
    }
    const { error: msgError } = await supabase.from("support_messages").insert({
      ticket_id: data.id,
      author_id: input.requesterId,
      author_role: input.role,
      body: input.body.slice(0, 4000),
    });
    if (msgError) throw msgError;
    return { id: data.id, number: Number(data.number) };
  } catch (e) {
    captureError(e, { source: "support/linked-ticket", attrs: { event: "linked_ticket_failed", category: input.category } });
    return null;
  }
}

/**
 * Ruling P2-R11: a pickup report (missing items, wrong package, shop delay,
 * other) becomes a `high` ticket linked to the order, and a shop delay is also
 * noted on the delivery's timeline (`delivery_events` kind `note`, 0087).
 */
export async function fileTicketForPickupReport(input: {
  driverId: string;
  orderId: string;
  deliveryId: string;
  kind: string;
  reason: string;
  notes?: string | null;
}): Promise<void> {
  const label = categoryLabel(input.kind);
  await createLinkedTicket({
    requesterId: input.driverId,
    role: "rider",
    category: input.kind,
    priority: "high",
    subject: `${label} — order #${shortOrderId(input.orderId)}`,
    body: [input.reason, input.notes].filter((x) => x && x.trim()).join("\n\n") || label,
    orderId: input.orderId,
  });
  if (input.kind === "vendor_delay") {
    try {
      const { error } = await createAdminClient().from("delivery_events").insert({
        delivery_id: input.deliveryId,
        order_id: input.orderId,
        driver_id: input.driverId,
        kind: "note",
        method: "vendor_delay",
        reason: `Shop delay reported by the rider: ${input.reason}`.slice(0, 500),
      });
      if (error) throw error;
    } catch (e) {
      captureError(e, { source: "support/vendor-delay-note", orderId: input.orderId, attrs: { event: "timeline_note_failed" } });
    }
  }
}

// ---------------------------------------------------------------------------
// staff
// ---------------------------------------------------------------------------

export interface StaffTicketRow extends TicketSummary {
  requesterId: string;
  requesterRole: string;
  requesterName: string;
  requesterPhone: string | null;
  assignedTo: string | null;
  locationUrl: string | null;
}

interface PersonRow {
  id: string;
  full_name: string | null;
  phone: string | null;
}

async function people(supabase: AdminClient, ids: string[]): Promise<Map<string, PersonRow>> {
  const out = new Map<string, PersonRow>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, phone")
    .in("id", unique)
    .overrideTypes<PersonRow[]>();
  for (const p of data ?? []) out.set(p.id, p);
  return out;
}

function staffRow(r: TicketRow, who: Map<string, PersonRow>): StaffTicketRow {
  const p = who.get(r.requester_id);
  return {
    ...summary(r),
    requesterId: r.requester_id,
    requesterRole: r.requester_role,
    requesterName: p?.full_name?.trim() || "Unnamed",
    requesterPhone: p?.phone ?? null,
    assignedTo: r.assigned_to,
    locationUrl: locationLink(r.lat, r.lng),
  };
}

/** Open emergencies first (newest first), then everything else by latest activity. */
function pinEmergencies(rows: StaffTicketRow[]): StaffTicketRow[] {
  const live = (r: StaffTicketRow) => r.priority === "emergency" && OPEN_STATUSES.includes(r.status);
  return [...rows.filter(live), ...rows.filter((r) => !live(r))];
}

/** The support desk's list: filters, emergencies pinned on top. */
export async function listTicketsForStaff(filter: TicketFilter, opts: { limit?: number } = {}): Promise<StaffTicketRow[]> {
  const supabase = createAdminClient();
  let q = supabase.from("support_tickets").select(TICKET_COLUMNS);
  if (filter.role) q = q.eq("requester_role", filter.role);
  if (filter.category) q = q.eq("category", filter.category);
  if (filter.priority) q = q.eq("priority", filter.priority);
  if (filter.status) q = q.eq("status", filter.status);
  const { data, error } = await q
    .order("updated_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500))
    .overrideTypes<TicketRow[]>();
  if (error) fail(error);
  const rows = data ?? [];
  const who = await people(supabase, rows.map((r) => r.requester_id));
  return pinEmergencies(rows.map((r) => staffRow(r, who)));
}

/** Every open emergency, newest first — the admin home and manager board banners. */
export async function listOpenEmergencies(): Promise<(StaffTicketRow & { riderCode: string | null })[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("priority", "emergency")
    .in("status", OPEN_STATUSES)
    .order("created_at", { ascending: false })
    .limit(20)
    .overrideTypes<TicketRow[]>();
  if (error) fail(error);
  const rows = data ?? [];
  const who = await people(supabase, rows.map((r) => r.requester_id));
  const codes = new Map<string, string | null>();
  if (rows.length) {
    const { data: rp } = await supabase
      .from("rider_profiles")
      .select("driver_id, rider_code")
      .in("driver_id", [...new Set(rows.map((r) => r.requester_id))])
      .overrideTypes<{ driver_id: string; rider_code: string | null }[]>();
    for (const r of rp ?? []) codes.set(r.driver_id, r.rider_code);
  }
  return rows.map((r) => ({ ...staffRow(r, who), riderCode: codes.get(r.requester_id) ?? null }));
}

/** One requester's tickets (admin rider page: tickets and incidents). */
export async function listTicketsOfRequester(requesterId: string): Promise<TicketSummary[]> {
  return listMyTickets(requesterId);
}

export interface StaffThread {
  ticket: StaffTicketRow & { riderCode: string | null; assignedName: string | null };
  messages: (TicketMessage & { internal: boolean; authorName: string; attachments: { path: string; url: string | null }[] })[];
}

/** The whole thread for staff: internal notes marked, every photo signed. */
export async function getTicketForStaff(id: string): Promise<StaffThread | null> {
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id);
  if (!row) return null;
  const messages = await readMessages(supabase, row.id, true);
  const who = await people(supabase, [row.requester_id, row.assigned_to ?? "", ...messages.map((m) => m.author_id)]);
  const urls = await signAttachments(messages.flatMap((m) => m.attachments ?? []), supabase);
  let riderCode: string | null = null;
  if (row.requester_role === "rider") {
    const { data } = await supabase
      .from("rider_profiles")
      .select("rider_code")
      .eq("driver_id", row.requester_id)
      .maybeSingle()
      .overrideTypes<{ rider_code: string | null }>();
    riderCode = data?.rider_code ?? null;
  }
  return {
    ticket: {
      ...staffRow(row, who),
      riderCode,
      assignedName: row.assigned_to ? who.get(row.assigned_to)?.full_name?.trim() || "Staff" : null,
    },
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      fromStaff: STAFF_ROLES.has(m.author_role),
      authorRole: m.author_role,
      authorName: who.get(m.author_id)?.full_name?.trim() || (STAFF_ROLES.has(m.author_role) ? "Deligro" : "Requester"),
      internal: m.internal,
      attachments: (m.attachments ?? []).map((p) => ({ path: p, url: urls.get(p) ?? null })),
      createdAt: m.created_at,
    })),
  };
}

const STATUS_WORDS: Record<TicketStatus, [string, string]> = {
  open: ["is open again", "Your ticket is open again."],
  in_progress: ["is being looked at", "Deligro support is working on it."],
  waiting_on_requester: ["needs your reply", "Deligro needs a little more from you."],
  escalated: ["was escalated", "Your ticket was passed to a senior team member."],
  resolved: ["is resolved", "Deligro marked your ticket resolved. Reply if you still need help."],
  closed: ["is closed", "Your ticket was closed."],
};

async function tellRequester(row: Pick<TicketRow, "id" | "number" | "requester_id" | "requester_role">, title: string, body: string): Promise<void> {
  await notifyUser({
    userId: row.requester_id,
    role: asRole(row.requester_role),
    category: "support",
    title,
    body: body.length > 180 ? `${body.slice(0, 177)}…` : body,
    url: ticketUrl(row.requester_role, row.id),
    data: { ticketId: row.id },
  });
}

/** An emergency someone has picked up: stop every ops phone ringing for it. */
async function quietIfEmergency(row: Pick<TicketRow, "id" | "priority">): Promise<void> {
  if (row.priority === "emergency") await stopOpsSosRing(row.id);
}

/**
 * Staff answer a ticket, or leave an internal note. A public reply moves the
 * ticket to "waiting on the requester" unless a status is given, and the
 * requester is pushed (`support`). An internal note tells nobody and moves
 * nothing unless a status is given.
 */
export async function staffReply(
  id: string,
  staff: StaffUser,
  input: { body: string; internal: boolean; status?: TicketStatus | null }
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id);
  if (!row) return { ok: false, error: "not_found" };
  const { error } = await supabase.from("support_messages").insert({
    ticket_id: row.id,
    author_id: staff.id,
    author_role: staff.role,
    body: input.body.slice(0, 4000),
    internal: input.internal,
  });
  if (error) fail(error);
  await quietIfEmergency(row);
  const next = input.status ?? (input.internal ? null : "waiting_on_requester");
  if (next) {
    await setTicketStatus(row.id, next, staff, { notify: false, row });
  } else {
    await supabase.from("support_tickets").update({ updated_at: new Date().toISOString() }).eq("id", row.id);
  }
  if (!input.internal) {
    await tellRequester(row, `Reply on ticket #${row.number}`, input.body);
  }
  return { ok: true };
}

/**
 * Move a ticket's status. The requester is pushed about every change
 * (`support`), unless the caller is a reply that already pushes.
 */
export async function setTicketStatus(
  id: string,
  status: TicketStatus,
  staff: StaffUser,
  opts: { notify?: boolean; row?: TicketRow } = {}
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const supabase = createAdminClient();
  const row = opts.row ?? (await readTicket(supabase, id));
  if (!row) return { ok: false, error: "not_found" };
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("support_tickets")
    .update({
      status,
      updated_at: now,
      resolved_at: status === "resolved" || status === "closed" ? now : null,
      assigned_to: row.assigned_to ?? staff.id,
    })
    .eq("id", row.id);
  if (error) fail(error);
  await quietIfEmergency(row);
  if (opts.notify !== false && status !== row.status) {
    const [title, body] = STATUS_WORDS[status];
    await tellRequester(row, `Ticket #${row.number} ${title}`, body);
  }
  return { ok: true };
}

/** "I've got this": assign to the caller; an open ticket becomes in progress. */
export async function assignTicketToSelf(id: string, staff: StaffUser): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id);
  if (!row) return { ok: false, error: "not_found" };
  const moving = row.status === "open";
  const { error } = await supabase
    .from("support_tickets")
    .update({ assigned_to: staff.id, updated_at: new Date().toISOString(), ...(moving ? { status: "in_progress" } : {}) })
    .eq("id", row.id);
  if (error) fail(error);
  await quietIfEmergency(row);
  if (moving) {
    const [title, body] = STATUS_WORDS.in_progress;
    await tellRequester(row, `Ticket #${row.number} ${title}`, body);
  }
  return { ok: true };
}
