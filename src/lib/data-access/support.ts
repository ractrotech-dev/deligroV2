import "server-only";
import { raiseEventAlert } from "@/lib/ops/alerts/engine";
import { alertFor } from "@/lib/ops/alerts/evaluate";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureError } from "@/lib/obs/emit";
import { shortOrderId } from "@/lib/utils/order-map";
import { isMissingColumn, isMissingTable } from "@/lib/data-access/schema-probe";
import { isMissingFunction } from "@/lib/data-access/rpc-fallback";
import { mapSupportRpcError, TICKET_TRANSITIONS, type TicketStatusDb } from "@/lib/ops/support-contract";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import { notifyUser, type NotificationRole } from "@/lib/notifications/notify-user";
import { stopOpsSosRing } from "@/lib/notifications/order-events";
import {
  removeAttachments,
  signAttachments,
  SUPPORT_BUCKET,
  uploadAttachments,
  validateAttachments,
} from "@/lib/data-access/support-attachments";
import type { TicketInput } from "@/lib/vendor/growth-input";
import { raiseSos } from "@/lib/data-access/sos";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyTicketEscalated } from "@/lib/notifications/ticket-escalation";
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
 * The Partner app's requester flow is merged in at the end of this file
 * ("Partner app requester flow"): same tables and rules, but the app uploads
 * photos first through a signed upload URL and then sends their paths, and
 * its JSON keeps the shape that app was built against. The Partner admin
 * functions were dropped in favour of the staff functions above (one desk).
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
    if (priority !== "normal") deferNotify(() => alertUrgentTicket(data.id));
    return { ok: true, id: data.id, number: Number(data.number), priority };
  } catch (e) {
    await removeAttachments(paths, supabase);
    throw e;
  }
}

/**
 * A high-priority or emergency ticket raises its complaint alert for the
 * ticket's zone at once (§14.11); the sweep keeps it open until the ticket is
 * resolved. The zone is the database's (0143 stamps it), read back here.
 */
async function alertUrgentTicket(id: string): Promise<void> {
  const { data } = await createAdminClient()
    .from("support_tickets")
    .select("id, number, category, zone_id, priority, status, created_at, first_response_at")
    .eq("id", id)
    .maybeSingle();
  const t = data as { id: string; number: number; category: string; zone_id: string | null; priority: string; status: string; created_at: string; first_response_at: string | null } | null;
  if (!t) return;
  await raiseEventAlert(alertFor.ticket({
    id: t.id, number: Number(t.number), category: t.category, zoneId: t.zone_id, priority: t.priority, status: t.status,
    createdAt: t.created_at, firstResponseAt: t.first_response_at,
  }, Number.POSITIVE_INFINITY, new Date()));
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
  | { ok: false; error: "not_found" | "invalid_message" | "ticket_closed" | AttachmentError };

/** The database refuses a requester's message on a closed ticket (0165). */
const isTicketClosed = (e: unknown): boolean => /ticket_closed/.test(String((e as { message?: string } | null)?.message ?? ""));

/**
 * The requester replies (with up to four photos). A ticket waiting on them
 * or resolved goes back in progress — the database does that, in one place
 * (0165's reply trigger), so this never writes the ticket's status. A closed
 * ticket is final: the reply is refused with "ticket_closed" and they start a
 * new one.
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
  if (row.status === "closed") return { ok: false, error: "ticket_closed" };

  const paths = await uploadAttachments(user.id, files, supabase);
  const { data, error } = await supabase
    .from("support_messages")
    .insert({ ticket_id: row.id, author_id: user.id, author_role: user.role, body: message.value, attachments: paths })
    .select("id")
    .single()
    .overrideTypes<{ id: string }>();
  if (error) {
    await removeAttachments(paths, supabase);
    if (isTicketClosed(error)) return { ok: false, error: "ticket_closed" };
    fail(error);
  }
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
    if ((input.priority ?? defaultPriority(input.category)) !== "normal") deferNotify(() => alertUrgentTicket(data.id));
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

/**
 * Every open emergency, newest first — the admin home and manager board
 * banners. `alertedAt` is when ops were last rung for it (0087
 * `sos_alerted_at`: the first tap, or a re-alert after staff acknowledged
 * it); the banner sounds again when it moves. A database with the shared
 * tables but not 0087's column falls back to the creation time.
 */
export async function listOpenEmergencies(): Promise<(StaffTicketRow & { riderCode: string | null; alertedAt: string })[]> {
  const supabase = createAdminClient();
  const query = (columns: string) =>
    supabase
      .from("support_tickets")
      .select(columns)
      .eq("priority", "emergency")
      .in("status", OPEN_STATUSES)
      .order("created_at", { ascending: false })
      .limit(20)
      .overrideTypes<(TicketRow & { sos_alerted_at?: string | null })[]>();
  let { data, error } = await query(`${TICKET_COLUMNS}, sos_alerted_at`);
  if (error && isMissingColumn(error)) ({ data, error } = await query(TICKET_COLUMNS));
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
  return rows.map((r) => ({
    ...staffRow(r, who),
    riderCode: codes.get(r.requester_id) ?? null,
    alertedAt: r.sos_alerted_at ?? r.created_at,
  }));
}

/** One requester's tickets (admin rider page: tickets and incidents). */
export async function listTicketsOfRequester(requesterId: string): Promise<TicketSummary[]> {
  return listMyTickets(requesterId);
}

export interface StaffThread {
  ticket: StaffTicketRow & { riderCode: string | null; assignedName: string | null };
  messages: (Omit<TicketMessage, "attachments"> & { internal: boolean; authorName: string; attachments: { path: string; url: string | null }[] })[];
}

/**
 * The whole thread for staff: internal notes marked, every photo signed.
 * `allow` is checked on the ticket BEFORE any message is read or any URL is
 * signed (the manager's view: `managerMaySeeTicket`); refused reads as null.
 */
export async function getTicketForStaff(
  id: string,
  opts: { allow?: (t: { requesterRole: string; priority: string; category: string }) => boolean } = {}
): Promise<StaffThread | null> {
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id);
  if (!row) return null;
  if (opts.allow && !opts.allow({ requesterRole: row.requester_role, priority: row.priority, category: row.category })) {
    return null;
  }
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
 * The support desk's writes (admin, and a manager "taking" a ticket) go
 * through the same audited RPCs the Manager app uses (0165): the change, the
 * history event and the `ops_audit_log` row happen in one transaction, the
 * transition table is enforced in the database, and the actor's zone is
 * checked there too. One path for every staff member, so the desk and the app
 * can never disagree about what a ticket may do or who did it.
 *
 * Each call carries a fresh client action id: the desk has no retry of its
 * own, so there is nothing to replay.
 */
export type DeskFailure = "not_found" | "invalid_transition" | "reason_required";
export type DeskOutcome = { ok: true } | { ok: false; error: DeskFailure };

const NOT_FOUND: DeskOutcome = { ok: false, error: "not_found" };

async function staffRpc(name: string, args: Record<string, unknown>): Promise<DeskOutcome> {
  const { error } = await createAdminClient().rpc(name, { ...args, p_client_action_id: randomUUID() });
  if (!error) return { ok: true };
  if (isMissingFunction(error)) throw new SupportNotMigratedError();
  const mapped = mapSupportRpcError(error);
  if (!mapped.ok) {
    if (mapped.error === "not_found") return NOT_FOUND;
    if (mapped.error === "invalid_transition") return { ok: false, error: "invalid_transition" };
    if (mapped.error === "reason_required" || mapped.error === "bad_request") return { ok: false, error: "reason_required" };
  }
  throw error;
}

const DESK_REOPEN_REASON = "Reopened from the support desk";
const DESK_ESCALATE_REASON = "Escalated from the support desk";

/** The status a ticket is in once a public reply has landed on it. */
const afterReply = (status: TicketStatus, internal: boolean): TicketStatus =>
  !internal && status === "open" ? "in_progress" : status;

/** Can `from` reach `to`? (`open` from the desk means "reopen a resolved ticket"; `escalated` means escalate.) */
function canMove(from: TicketStatus, to: TicketStatus): boolean {
  if (to === from) return true;
  if (to === "escalated") return from !== "closed" && from !== "resolved";
  if (to === "open") return from === "resolved" || from === "in_progress";
  return (TICKET_TRANSITIONS[from as TicketStatusDb] ?? []).includes(to as TicketStatusDb);
}

/** Moves a ticket to `to` through the audited RPCs; a no-op when it is already there. */
async function moveTicket(
  row: Pick<TicketRow, "id" | "status">,
  to: TicketStatus,
  staff: StaffUser,
  opts: { resolution?: string | null } = {}
): Promise<DeskOutcome> {
  if (to === row.status) return { ok: true };
  if (to === "escalated") {
    const done = await staffRpc("ops_escalate_ticket", { p_actor: staff.id, p_ticket: row.id, p_reason: DESK_ESCALATE_REASON });
    // The desk used to escalate in silence; it tells the staff exactly as the app does (review #24).
    if (done.ok) deferNotify(() => notifyTicketEscalated(row.id));
    return done;
  }
  if (to === "open") {
    // The desk's "Reopen": a resolved ticket goes back to being worked on.
    return row.status === "resolved" ? moveTicket(row, "in_progress", staff) : { ok: true };
  }
  return staffRpc("ops_set_ticket_status", {
    p_actor: staff.id,
    p_ticket: row.id,
    p_status: to,
    p_resolution: to === "resolved" || to === "closed" ? opts.resolution?.trim() || null : null,
    p_reason: row.status === "resolved" && to === "in_progress" ? DESK_REOPEN_REASON : null,
  });
}

/** The ticket's team, so assigning someone keeps it (the RPC sets both). Null before 0165. */
async function ticketTeam(id: string): Promise<string | null> {
  const { data, error } = await createAdminClient().from("support_tickets").select("team").eq("id", id).maybeSingle();
  if (error) return null;
  return (data as { team?: string | null } | null)?.team ?? null;
}

/** The first status move on an unassigned ticket also takes it ("I've got this"). */
async function takeIfUnassigned(row: Pick<TicketRow, "id" | "assigned_to">, staff: StaffUser): Promise<void> {
  if (row.assigned_to) return;
  await staffRpc("ops_assign_ticket", { p_actor: staff.id, p_ticket: row.id, p_assignee: staff.id, p_team: await ticketTeam(row.id) });
}

/**
 * Staff answer a ticket, or leave an internal note. A public reply moves the
 * ticket to "waiting on the requester" unless a status is given, and the
 * requester is pushed (`support`). An internal note tells nobody and moves
 * nothing unless a status is given. Resolving takes a resolution: the one
 * given, else the words of a public reply (never those of an internal note).
 */
export async function staffReply(
  id: string,
  staff: StaffUser,
  input: { body: string; internal: boolean; status?: TicketStatus | null; resolution?: string | null }
): Promise<DeskOutcome> {
  const row = await readTicket(createAdminClient(), id);
  if (!row) return NOT_FOUND;
  const body = input.body.slice(0, 4000);
  const landed = afterReply(row.status, input.internal);
  // An explicit status the ticket cannot reach is refused before anything is sent.
  if (input.status && !canMove(landed, input.status)) return { ok: false, error: "invalid_transition" };
  const next = input.status ?? (input.internal ? null : "waiting_on_requester");
  // The default move ("waiting on them") is skipped, not refused, where it is not allowed (a resolved ticket).
  const move = next && (input.status || canMove(landed, next)) ? next : null;
  // The resolution is the requester's to read, so an internal note's words never become it.
  const resolution = input.resolution?.trim() || (input.internal ? null : body);
  if (move === "resolved" && !resolution) return { ok: false, error: "reason_required" };

  const sent = await staffRpc("ops_add_ticket_message", { p_actor: staff.id, p_ticket: row.id, p_body: body, p_internal: input.internal, p_attachments: [] });
  if (!sent.ok) return sent;
  await quietIfEmergency(row);
  const landedRow = { id: row.id, status: landed, assigned_to: row.assigned_to };
  if (move) {
    const moved = await moveTicket(landedRow, move, staff, { resolution });
    if (!moved.ok) return moved;
    await takeIfUnassigned(landedRow, staff);
    // A public reply already pushes the requester; a status change made with
    // an internal note still tells them about the status (never the note).
    if (input.internal && move !== landed) {
      const [title, words] = STATUS_WORDS[move];
      await tellRequester(row, `Ticket #${row.number} ${title}`, words);
    }
  }
  if (!input.internal) {
    await tellRequester(row, `Reply on ticket #${row.number}`, input.body);
  }
  return { ok: true };
}

/**
 * Move a ticket's status. The requester is pushed about every change
 * (`support`), unless the caller is a reply that already pushes. Resolving
 * needs a resolution (3–1000 characters); closing needs the ticket resolved.
 */
export async function setTicketStatus(
  id: string,
  status: TicketStatus,
  staff: StaffUser,
  opts: { notify?: boolean; row?: TicketRow; resolution?: string | null } = {}
): Promise<DeskOutcome> {
  const row = opts.row ?? (await readTicket(createAdminClient(), id));
  if (!row) return NOT_FOUND;
  if (!canMove(row.status, status)) return { ok: false, error: "invalid_transition" };
  const moved = await moveTicket(row, status, staff, { resolution: opts.resolution });
  if (!moved.ok) return moved;
  await takeIfUnassigned(row, staff);
  await quietIfEmergency(row);
  if (opts.notify !== false && status !== row.status) {
    const [title, body] = STATUS_WORDS[status];
    await tellRequester(row, `Ticket #${row.number} ${title}`, body);
  }
  return { ok: true };
}

/** "I've got this": assign to the caller; an open ticket becomes in progress. */
export async function assignTicketToSelf(id: string, staff: StaffUser): Promise<DeskOutcome> {
  const row = await readTicket(createAdminClient(), id);
  if (!row) return NOT_FOUND;
  const moving = row.status === "open";
  const assigned = await staffRpc("ops_assign_ticket", { p_actor: staff.id, p_ticket: row.id, p_assignee: staff.id, p_team: await ticketTeam(row.id) });
  if (!assigned.ok) return assigned;
  if (moving) {
    const moved = await moveTicket(row, "in_progress", staff);
    if (!moved.ok) return moved;
  }
  await quietIfEmergency(row);
  if (moving) {
    const [title, body] = STATUS_WORDS.in_progress;
    await tellRequester(row, `Ticket #${row.number} ${title}`, body);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Partner app requester flow (feat/vendor-app, merged here)
// ---------------------------------------------------------------------------
//
// The Partner app uploads each photo to `support-attachments/<its own id>/…`
// through a signed upload URL, then sends the paths with the ticket or reply.
// A path outside the caller's own folder is refused, so nobody can attach
// someone else's file. The routes (`/api/vendor/support/**`) check the vendor
// and the shop; these functions take the requester id from them.

export interface AppTicketSummary {
  id: string;
  number: number;
  category: string;
  subject: string;
  status: TicketStatus;
  priority: string;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppTicketMessage {
  id: string;
  body: string;
  fromYou: boolean;
  authorRole: string;
  internal: false;
  attachments: { path: string; url: string | null }[];
  createdAt: string;
}

function appSummary(r: TicketRow): AppTicketSummary {
  return {
    id: r.id,
    number: Number(r.number),
    category: r.category,
    subject: r.subject,
    status: r.status,
    priority: r.priority ?? "normal",
    orderId: r.order_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Only files the caller uploaded into their own folder may be attached. */
function ownPaths(userId: string, paths: readonly string[]): boolean {
  return paths.every((p) => p.startsWith(`${userId}/`) && !p.includes(".."));
}

/** A signed upload URL for one photo in the uploader's own folder. */
export async function attachmentUploadUrl(userId: string, ext: "jpg" | "png"): Promise<{ path: string; url: string; token: string }> {
  const path = `${userId}/${randomUUID()}.${ext}`;
  const { data, error } = await createAdminClient().storage.from(SUPPORT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("upload_url_failed");
  return { path, url: data.signedUrl, token: data.token };
}

/** The Partner app's tickets, newest activity first. */
export async function listMyAppTickets(userId: string): Promise<AppTicketSummary[]> {
  const { data, error } = await createAdminClient()
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("requester_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100)
    .overrideTypes<TicketRow[]>();
  if (error) fail(error);
  return (data ?? []).map(appSummary);
}

/** Opens a ticket with already-uploaded photos. The route has checked the order is the caller's. */
export async function createAppTicket(userId: string, role: NotificationRole, input: TicketInput): Promise<AppTicketSummary | null> {
  if (!ownPaths(userId, input.attachments)) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("support_tickets")
    .insert({
      requester_id: userId,
      requester_role: role,
      category: input.category,
      priority: defaultPriority(input.category),
      subject: input.subject,
      order_id: input.orderId,
    })
    .select(TICKET_COLUMNS)
    .single()
    .overrideTypes<TicketRow>();
  if (error) fail(error);
  const { error: msgError } = await supabase.from("support_messages").insert({
    ticket_id: data.id,
    author_id: userId,
    author_role: role,
    body: input.body,
    attachments: input.attachments,
  });
  if (msgError) fail(msgError);
  return appSummary(data);
}

/** The requester's ticket and its non-internal messages; null when not theirs. */
export async function getMyAppTicket(userId: string, id: string): Promise<{ ticket: AppTicketSummary; messages: AppTicketMessage[] } | null> {
  if (!isUuid(id)) return null;
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id, userId);
  if (!row || row.requester_id !== userId) return null;
  const messages = await readMessages(supabase, row.id, false);
  const urls = await signAttachments(messages.flatMap((m) => m.attachments ?? []), supabase);
  return {
    ticket: appSummary(row),
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      fromYou: m.author_id === userId,
      authorRole: m.author_role,
      internal: false,
      attachments: (m.attachments ?? []).map((p) => ({ path: p, url: urls.get(p) ?? null })),
      createdAt: m.created_at,
    })),
  };
}

/**
 * The requester replies with already-uploaded photos. A resolved or waiting
 * ticket goes back in progress (the database does it, 0165); a closed ticket
 * is final — "ticket_closed". "not_found" when the ticket is not theirs.
 */
export async function replyToMyAppTicket(
  userId: string,
  role: NotificationRole,
  id: string,
  message: { body: string; attachments: string[] }
): Promise<"ok" | "not_found" | "bad_attachment" | "ticket_closed"> {
  if (!isUuid(id)) return "not_found";
  if (!ownPaths(userId, message.attachments)) return "bad_attachment";
  const supabase = createAdminClient();
  const row = await readTicket(supabase, id, userId);
  if (!row || row.requester_id !== userId) return "not_found";
  if (row.status === "closed") return "ticket_closed";
  const { error: mErr } = await supabase.from("support_messages").insert({
    ticket_id: id,
    author_id: userId,
    author_role: role,
    body: message.body,
    attachments: message.attachments,
  });
  if (mErr) {
    if (isTicketClosed(mErr)) return "ticket_closed";
    fail(mErr);
  }
  return "ok";
}
