/**
 * The order detail's pure parts: the merged timeline, the actions this manager
 * may take on this order now, and the serialiser that applies the phone rule.
 */
import type {
  AllowedActions,
  DbOrderStatus,
  OrderDetail,
  TimelineEntry,
} from "./order-contract";
import { toOrderListItem, type OpsOrderRow } from "./order-row";

export interface StatusEventIn { at: string; kind: string; from: string | null; to: string | null; actorId: string | null; reason: string | null }
export interface DeliveryEventIn { at: string; kind: string; driverId: string | null; actorId: string | null; reason: string | null; method: string | null }
export interface NoteIn { at: string; authorId: string; body: string }
export interface AuditIn { at: string; action: string; actorId: string; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface ActorIn { id: string; name: string; role: string }

/** profiles.role → the contract's actor role. */
function contractRole(role: string): string {
  if (role === "restaurant") return "vendor";
  if (["manager", "admin", "driver", "customer"].includes(role)) return role;
  return "system";
}

/**
 * Audit rows that add something the status and delivery trails do not:
 * corrections and escalations. Advance, cancel, assign and reassign already
 * appear as order or delivery events (with the actor and reason the RPC set).
 */
const OPS_KINDS: Record<string, string> = {
  "order.correct.status": "corrected",
  "order.correct.delivery_status": "corrected",
  "order.correct.item_unavailable": "corrected",
  "order.correct.address_note": "corrected",
  "order.escalate": "escalated",
};

const SOURCE_RANK: Record<TimelineEntry["source"], number> = { order: 0, delivery: 1, ops: 2 };

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

/** Oldest first; equal times keep source order (order, delivery, ops), then input order. */
export function mergeTimeline(
  statusEvents: StatusEventIn[],
  deliveryEvents: DeliveryEventIn[],
  notes: NoteIn[],
  audits: AuditIn[],
  actors: Map<string, ActorIn>
): TimelineEntry[] {
  const actor = (id: string | null): TimelineEntry["actor"] => {
    if (!id) return null;
    const a = actors.get(id);
    return a ? { id: a.id, name: a.name, role: contractRole(a.role) } : null;
  };

  const entries: (TimelineEntry & { seq: number })[] = [];
  let seq = 0;
  for (const e of statusEvents) {
    entries.push({ at: e.at, source: "order", kind: e.kind, from: e.from, to: e.to, actor: actor(e.actorId), reason: e.reason, method: null, seq: seq++ });
  }
  for (const e of deliveryEvents) {
    entries.push({ at: e.at, source: "delivery", kind: e.kind, from: null, to: null, actor: actor(e.actorId), reason: e.reason, method: e.method, seq: seq++ });
  }
  for (const n of notes) {
    entries.push({ at: n.at, source: "ops", kind: "note", from: null, to: null, actor: actor(n.authorId), reason: n.body, method: null, seq: seq++ });
  }
  for (const a of audits) {
    const kind = OPS_KINDS[a.action];
    if (!kind) continue;
    const pick = (o: Record<string, unknown> | null) => str(o?.status ?? o?.deliveryStatus ?? o?.escalationLevel ?? null);
    entries.push({
      at: a.at, source: "ops", kind, from: pick(a.before), to: pick(a.after),
      actor: actor(a.actorId), reason: a.reason, method: a.action.startsWith("order.correct.") ? a.action.slice(14) : null, seq: seq++,
    });
  }

  entries.sort((x, y) => {
    const t = Date.parse(x.at) - Date.parse(y.at);
    if (t !== 0) return t;
    const s = SOURCE_RANK[x.source] - SOURCE_RANK[y.source];
    return s !== 0 ? s : x.seq - y.seq;
  });
  return entries.map((e) => {
    const { seq, ...entry } = e;
    void seq;
    return entry;
  });
}

const NEXT: Partial<Record<DbOrderStatus, DbOrderStatus>> = {
  placed: "kitchen",
  kitchen: "ready",
  ready: "on_the_way",
  on_the_way: "delivered",
};

export interface DetailFacts {
  status: DbOrderStatus;
  /** The delivery row's status, or null when there is no row. */
  deliveryStatus: string | null;
}

/** What this caller may do to this order now — state and permission together. */
export function allowedActions(f: DetailFacts, permissions: Record<string, boolean>): AllowedActions {
  const can = (k: string) => permissions[k] === true;
  const active = f.status !== "delivered" && f.status !== "cancelled";
  // A failed or cancelled leg of a live order takes a new rider (0142 new leg).
  const riderless = f.deliveryStatus === null || f.deliveryStatus === "unassigned"
    || f.deliveryStatus === "failed" || f.deliveryStatus === "cancelled";
  const riding = f.deliveryStatus === "assigned" || f.deliveryStatus === "picked_up";
  return {
    advance: active && can("manager.move_status") ? (NEXT[f.status] ?? null) : null,
    cancel: active && can("manager.move_status"),
    assign: active && riderless && can("manager.assign_rider"),
    reassign: active && riding && can("manager.reassign_rider"),
    escalate: can("manager.orders.escalate"),
    correct: f.status !== "cancelled" && can("manager.orders.correct"),
    note: can("manager.orders.correct"),
  };
}

export interface DetailExtras {
  items: { id: string; name: string; qty: number; price: number }[];
  money: OrderDetail["money"];
  pickup: OrderDetail["pickup"];
  drop: OrderDetail["drop"];
  customer: { name: string | null; phone: string | null };
  delivery: OrderDetail["delivery"];
  timeline: TimelineEntry[];
  tickets: OrderDetail["tickets"];
}

/** The pinned `OrderDetail`. The customer's phone key exists only with `manager.call_customer`. */
export function toOrderDetail(
  row: OpsOrderRow,
  x: DetailExtras,
  permissions: Record<string, boolean>,
  now: Date
): OrderDetail {
  const customer: OrderDetail["customer"] = { name: x.customer.name };
  if (permissions["manager.call_customer"] === true) customer.phone = x.customer.phone;
  return {
    ...toOrderListItem(row, now),
    items: x.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, lineTotal: i.qty * i.price })),
    money: x.money,
    pickup: x.pickup,
    drop: x.drop,
    customer,
    delivery: x.delivery,
    timeline: x.timeline,
    tickets: x.tickets,
    allowed: allowedActions({ status: row.status, deliveryStatus: x.delivery?.status ?? row.delivery?.status ?? null }, permissions),
  };
}
