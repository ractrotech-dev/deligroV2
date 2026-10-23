import { isUuid } from "@/lib/auth/manager-scope";
import { mapVendorRpcError } from "@/lib/ops/vendor-actions";
import { toTicketSummary, type TicketRow, type TicketSummary } from "@/lib/ops/vendor-contract";
import type { OpsResult } from "@/lib/ops/order-actions";

/**
 * The support queue's contract (Phase 8, §11) — pure, so the routes, the
 * contract check and the tests share one definition. English only.
 */

export const TICKET_STATUSES = ["open", "in_progress", "waiting_on_requester", "escalated", "resolved", "closed"] as const;
export type TicketStatusDb = (typeof TICKET_STATUSES)[number];
export const ACTIVE_STATUSES: readonly TicketStatusDb[] = ["open", "in_progress", "waiting_on_requester", "escalated"];
export const TICKET_PRIORITIES = ["normal", "high", "emergency"] as const;
export const TEAMS = ["operations", "finance", "vendor_support", "rider_support", "customer_support"] as const;
export type Team = (typeof TEAMS)[number];

/** The contract's requester roles ↔ what the tables store (0064 / 0087). */
export const REQUESTER_ROLES = ["restaurant", "driver", "customer", "manager", "admin"] as const;
const STORED_ROLE: Record<string, string[]> = {
  restaurant: ["vendor", "restaurant"],
  driver: ["rider", "driver"],
  customer: ["customer"],
  manager: ["manager"],
  admin: ["admin"],
};
export function contractRole(stored: string): string {
  if (stored === "vendor") return "restaurant";
  if (stored === "rider") return "driver";
  return stored;
}

/**
 * The staff transition table — the TypeScript twin of
 * `ops_ticket_allowed_transitions()` (0165); scripts/qa/manager-support.ts
 * holds the two equal. `escalated` is reached only by escalating.
 */
export const TICKET_TRANSITIONS: Record<TicketStatusDb, readonly TicketStatusDb[]> = {
  open: ["in_progress", "waiting_on_requester", "resolved"],
  in_progress: ["waiting_on_requester", "resolved"],
  waiting_on_requester: ["in_progress", "resolved"],
  escalated: ["in_progress", "waiting_on_requester", "resolved"],
  resolved: ["closed", "in_progress"],
  closed: [],
};

export type TicketListItem = TicketSummary & {
  zoneId: string | null;
  restaurant: { id: string; name: string } | null;
  requester: { id: string; name: string; role: string };
  assignee: { id: string; name: string } | null;
  team: Team | null;
  escalationLevel: number;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  ageMinutes: number;
  awaitingFirstResponse: boolean;
  unreadForStaff: number;
};

export interface TicketCounts {
  open: number;
  in_progress: number;
  waiting_on_requester: number;
  escalated: number;
  resolved: number;
  closed: number;
  unassigned: number;
  mine: number;
}

export interface TicketEvent {
  id: number;
  at: string;
  kind: "created" | "status" | "assigned" | "team" | "priority" | "escalated" | "reopened" | "first_response" | "attachment";
  from: string | null;
  to: string | null;
  actor: { id: string; name: string; role: string } | null;
  reason: string | null;
  internal: boolean;
}

export type QueueRow = TicketRow & {
  requester_id: string;
  restaurant_id: string | null;
  zone_id: string | null;
  assigned_to: string | null;
  team: string | null;
  escalation_level: number | null;
  first_response_at: string | null;
  resolved_at: string | null;
};

export const QUEUE_COLUMNS =
  "id, number, subject, category, priority, status, requester_role, order_id, created_at, updated_at, requester_id, restaurant_id, zone_id, assigned_to, team, escalation_level, first_response_at, resolved_at";

export function toTicketListItem(
  r: QueueRow,
  names: { people: Map<string, string>; shops: Map<string, string> },
  unread: number,
  now: Date
): TicketListItem {
  return {
    ...toTicketSummary(r),
    zoneId: r.zone_id,
    restaurant: r.restaurant_id ? { id: r.restaurant_id, name: names.shops.get(r.restaurant_id) ?? "Shop" } : null,
    requester: { id: r.requester_id, name: names.people.get(r.requester_id) ?? "User", role: contractRole(r.requester_role) },
    assignee: r.assigned_to ? { id: r.assigned_to, name: names.people.get(r.assigned_to) ?? "Staff" } : null,
    team: (TEAMS as readonly string[]).includes(r.team ?? "") ? (r.team as Team) : null,
    escalationLevel: r.escalation_level ?? 0,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    ageMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(r.created_at)) / 60_000)),
    awaitingFirstResponse: !r.first_response_at && r.status !== "resolved" && r.status !== "closed",
    unreadForStaff: unread,
  };
}

/** Escalated or emergency first, then newest. */
export function isUrgent(r: { status: string; priority: string }): boolean {
  return r.status === "escalated" || r.priority === "emergency";
}

// ── query ─────────────────────────────────────────────────────────────────

export interface TicketQuery {
  statuses: TicketStatusDb[] | null;
  categories: string[] | null;
  priorities: string[] | null;
  /** Stored roles. */
  requesterRoles: string[] | null;
  /** IST dates, inclusive. */
  from: string | null;
  to: string | null;
  zone: string | null;
  assignee: "me" | "unassigned" | string | null;
  team: Team | null;
  vendor: string | null;
  rider: string | null;
  q: { kind: "number"; value: number } | { kind: "text"; value: string } | null;
  cursor: { at: string; id: string } | null;
  limit: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

export function encodeCursor(c: { at: string; id: string }): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    return at && id && !Number.isNaN(Date.parse(at)) && isUuid(id) ? { at, id } : null;
  } catch {
    return null;
  }
}

export function parseTicketQuery(sp: URLSearchParams): TicketQuery | { error: "bad_request"; field: string } {
  const fail = (field: string) => ({ error: "bad_request" as const, field });

  let statuses: TicketStatusDb[] | null = null;
  const rawStatus = list(sp.get("status"));
  if (rawStatus) {
    const out = new Set<TicketStatusDb>();
    for (const s of rawStatus) {
      if (s === "active") ACTIVE_STATUSES.forEach((a) => out.add(a));
      else if ((TICKET_STATUSES as readonly string[]).includes(s)) out.add(s as TicketStatusDb);
      else return fail("status");
    }
    statuses = [...out];
  }

  const categories = list(sp.get("category"));
  if (categories?.some((c) => !/^[a-z_]{2,40}$/.test(c))) return fail("category");

  const priorities = list(sp.get("priority"));
  if (priorities?.some((p) => !(TICKET_PRIORITIES as readonly string[]).includes(p))) return fail("priority");

  let requesterRoles: string[] | null = null;
  const roles = list(sp.get("requesterRole"));
  if (roles) {
    if (roles.some((r) => !(REQUESTER_ROLES as readonly string[]).includes(r))) return fail("requesterRole");
    requesterRoles = roles.flatMap((r) => STORED_ROLE[r]);
  }

  const from = sp.get("from");
  const to = sp.get("to");
  if (from && !DAY.test(from)) return fail("from");
  if (to && !DAY.test(to)) return fail("to");
  if (from && to && from > to) return fail("from");

  const zone = sp.get("zone");
  if (zone && !isUuid(zone)) return fail("zone");

  const assignee = sp.get("assignee");
  if (assignee && assignee !== "me" && assignee !== "unassigned" && !isUuid(assignee)) return fail("assignee");

  const team = sp.get("team");
  if (team && !(TEAMS as readonly string[]).includes(team)) return fail("team");

  const vendor = sp.get("vendor");
  if (vendor && !isUuid(vendor)) return fail("vendor");
  const rider = sp.get("rider");
  if (rider && !isUuid(rider)) return fail("rider");

  let q: TicketQuery["q"] = null;
  const rawQ = sp.get("q")?.trim().replace(/^#/, "");
  if (rawQ) {
    if (/^\d{1,12}$/.test(rawQ)) q = { kind: "number", value: Number(rawQ) };
    else if (rawQ.length >= 3 && rawQ.length <= 80) q = { kind: "text", value: rawQ };
    else return fail("q");
  }

  let cursor: TicketQuery["cursor"] = null;
  const rawCursor = sp.get("cursor");
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return fail("cursor");
  }

  const rawLimit = sp.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) return fail("limit");
    limit = Number(rawLimit);
  }

  return {
    statuses, categories, priorities, requesterRoles, from, to, zone: zone ? zone.toLowerCase() : null,
    assignee: assignee && isUuid(assignee) ? assignee.toLowerCase() : assignee, team: (team as Team) ?? null,
    vendor: vendor?.toLowerCase() ?? null, rider: rider?.toLowerCase() ?? null, q, cursor, limit,
  };
}

// ── action bodies ─────────────────────────────────────────────────────────

type Fail = { ok: false; status: 400; error: "bad_request" | "reason_required"; field?: string };
const bad = (field: string): Fail => ({ ok: false, status: 400, error: "bad_request", field });
const needReason: Fail = { ok: false, status: 400, error: "reason_required" };
const textOf = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : null;
};
const cidOf = (body: Record<string, unknown>) =>
  typeof body.clientActionId === "string" && isUuid(body.clientActionId) ? body.clientActionId : null;

export function parseAssignBody(body: Record<string, unknown> | null):
  { ok: true; value: { assigneeId: string | null; team: Team | null; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  const cid = cidOf(body);
  if (!cid) return bad("clientActionId");
  if (body.assigneeId !== null && (typeof body.assigneeId !== "string" || !isUuid(body.assigneeId))) return bad("assigneeId");
  if (body.team !== null && body.team !== undefined && !(TEAMS as readonly unknown[]).includes(body.team)) return bad("team");
  return { ok: true, value: { assigneeId: (body.assigneeId as string | null)?.toLowerCase() ?? null, team: (body.team as Team | null | undefined) ?? null, clientActionId: cid } };
}

export function parsePriorityBody(body: Record<string, unknown> | null):
  { ok: true; value: { priority: (typeof TICKET_PRIORITIES)[number]; reason: string; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  const cid = cidOf(body);
  if (!cid) return bad("clientActionId");
  if (!(TICKET_PRIORITIES as readonly unknown[]).includes(body.priority)) return bad("priority");
  const reason = textOf(body.reason, 3, 300);
  if (!reason) return needReason;
  return { ok: true, value: { priority: body.priority as (typeof TICKET_PRIORITIES)[number], reason, clientActionId: cid } };
}

export function parseEscalateBody(body: Record<string, unknown> | null):
  { ok: true; value: { reason: string; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  const cid = cidOf(body);
  if (!cid) return bad("clientActionId");
  const reason = textOf(body.reason, 3, 300);
  if (!reason) return needReason;
  return { ok: true, value: { reason, clientActionId: cid } };
}

export const MANAGER_SET_STATUSES = ["in_progress", "waiting_on_requester", "resolved", "closed"] as const;

/** Status moves: a resolution to resolve (closing reuses it); a reason to reopen (the database decides which is a reopen). */
export function parseStatusBody(body: Record<string, unknown> | null):
  { ok: true; value: { status: (typeof MANAGER_SET_STATUSES)[number]; resolution: string | null; reason: string | null; clientActionId: string } } | Fail {
  if (!body) return bad("body");
  const cid = cidOf(body);
  if (!cid) return bad("clientActionId");
  if (!(MANAGER_SET_STATUSES as readonly unknown[]).includes(body.status)) return bad("status");
  const status = body.status as (typeof MANAGER_SET_STATUSES)[number];
  const resolution = body.resolution === undefined || body.resolution === null ? null : textOf(body.resolution, 3, 1000);
  if (body.resolution !== undefined && body.resolution !== null && !resolution) return needReason;
  if (status === "resolved" && !resolution) return needReason;
  const reason = body.reason === undefined || body.reason === null ? null : textOf(body.reason, 3, 300);
  if (body.reason !== undefined && body.reason !== null && !reason) return needReason;
  return { ok: true, value: { status, resolution, reason, clientActionId: cid } };
}

// ── attachments ───────────────────────────────────────────────────────────

export const ATTACHMENT_MAX_FILES = 4;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const KINDS: { mime: string; ext: string; magic: (b: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/webp", ext: "webp", magic: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP" },
  { mime: "application/pdf", ext: "pdf", magic: (b) => String.fromCharCode(...b.slice(0, 4)) === "%PDF" },
];

/** One uploaded file checked by its type, size and first bytes. The extension comes from the bytes, never the name. */
export function checkAttachment(file: { type: string; size: number }, head: Uint8Array): { ok: true; mime: string; ext: string } | { ok: false } {
  if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES) return { ok: false };
  const kind = KINDS.find((k) => k.mime === file.type);
  if (!kind || !kind.magic(head)) return { ok: false };
  return { ok: true, mime: kind.mime, ext: kind.ext };
}

// ── errors ────────────────────────────────────────────────────────────────

/** A ticket RPC's raised error → the pinned HTTP answer. */
export function mapSupportRpcError(e: { code?: string; message?: string; details?: string | null }): OpsResult {
  const message = (e.message ?? "").trim();
  if (message === "assignee_ineligible") return { ok: false, status: 409, error: "assignee_ineligible" };
  if (message === "max_level") return { ok: false, status: 409, error: "max_level" };
  if (message === "bad_team") return { ok: false, status: 400, error: "bad_request", extra: { field: "team" } };
  if (message === "bad_file") return { ok: false, status: 400, error: "bad_file" };
  if (message === "bad_request") return { ok: false, status: 400, error: "bad_request" };
  if (message === "invalid_transition") {
    const allowed = (e.details ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { ok: false, status: 409, error: "invalid_transition", extra: { allowed } };
  }
  return mapVendorRpcError(e);
}

