/**
 * The Manager app's order and live-operations wire format — the JSON pinned in
 * docs/superpowers/plans/2026-10-21-manager-app-phase-3-orders-live.md ("API
 * contract"). The Flutter app's models parse exactly these shapes, so a field
 * changes here only together with `apps/manager/lib/models`.
 *
 * Types only, plus the small pure helpers every serialiser shares. No I/O.
 */

/** The database's order status (`order_status` enum), not the UI's upper-case one. */
export type DbOrderStatus = "placed" | "kitchen" | "ready" | "on_the_way" | "delivered" | "cancelled";

export type DeliveryStatus =
  | "unassigned"
  | "assigned"
  | "picked_up"
  | "delivered"
  | "failed"
  | "cancelled";

export interface EtaView {
  pickupAt: string | null;
  expectedAt: string | null;
  dueAt: string | null;
  late: boolean;
  lateByMinutes: number;
}

/** `accept`: a placed order the kitchen has not accepted in time. */
export type DelayKind = "accept" | "unassigned" | "delivery" | "pickup" | "prep";

export interface OrderListItem {
  id: string;
  code: string;
  status: DbOrderStatus;
  createdAt: string;
  zoneId: string | null;
  vendor: { id: string; name: string };
  customerName: string | null;
  total: number;
  itemCount: number;
  payment: { method: string | null; status: string | null };
  rider: { id: string; name: string; code: string | null } | null;
  deliveryStatus: DeliveryStatus | null;
  byPhone: boolean;
  eta: EtaView | null;
  delay: { kind: DelayKind; minutes: number } | null;
  cancellation: { by: string | null; reason: string | null; at: string | null } | null;
}

export type TimelineSource = "order" | "delivery" | "ops";

export interface TimelineEntry {
  at: string;
  source: TimelineSource;
  kind: string;
  from: string | null;
  to: string | null;
  actor: { id: string; name: string; role: string } | null;
  reason: string | null;
  method: string | null;
}

export type IneligibleReason =
  | "offline"
  | "on_break"
  | "stale_fix"
  | "suspended"
  | "out_of_zone"
  | "current_rider";

export interface RiderCandidate {
  id: string;
  name: string;
  code: string | null;
  phase: "online" | "break" | "stale" | "offline";
  activeDeliveries: number;
  distanceKm: number | null;
  lastFixAgeSeconds: number | null;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
}

export interface AllowedActions {
  advance: DbOrderStatus | null;
  cancel: boolean;
  assign: boolean;
  reassign: boolean;
  escalate: boolean;
  correct: boolean;
  note: boolean;
}

export interface OrderDetail extends OrderListItem {
  items: { id: string; name: string; qty: number; price: number; lineTotal: number }[];
  money: { subtotal: number; discount: number; deliveryFee: number; tax: number; tip: number; total: number };
  pickup: { name: string; address: string | null; lat: number | null; lng: number | null; phone: string | null };
  drop: { label: string | null; address: string | null; landmark: string | null; lat: number | null; lng: number | null };
  /** `phone` is present only with `manager.call_customer`. */
  customer: { name: string | null; phone?: string | null };
  delivery: {
    id: string;
    status: DeliveryStatus;
    rider: { id: string; name: string; code: string | null; phone: string | null } | null;
    offeredTo: { id: string; name: string } | null;
    assignedAt: string | null;
    pickedUpAt: string | null;
    deliveredAt: string | null;
    failedAt: string | null;
    failureReason: string | null;
    lastFix: { lat: number; lng: number; at: string; ageSeconds: number } | null;
  } | null;
  timeline: TimelineEntry[];
  tickets: { id: string; number: number; status: string; priority: string }[];
  allowed: AllowedActions;
}

export type RiderMarkerState = "available" | "on_delivery" | "break" | "stale";

export type SignalKind =
  | "rider_inactive"
  | "delivery_failed"
  | "delivery_delayed"
  | "order_unassigned"
  | "prep_delayed"
  | "accept_delayed";

export interface LiveSignal {
  kind: SignalKind;
  orderId: string | null;
  riderId: string | null;
  minutes: number;
  at: string;
}

export interface LiveRider {
  id: string;
  name: string;
  code: string | null;
  state: RiderMarkerState;
  lat: number | null;
  lng: number | null;
  lastFixAt: string | null;
  lastFixAgeSeconds: number | null;
  stale: boolean;
  activeOrderIds: string[];
  /** Only for a rider in the caller's zones who is online or on a delivery; else null. */
  phone: string | null;
}

export type LiveOrder = OrderListItem & {
  pickupPoint: { lat: number; lng: number } | null;
  dropPoint: { lat: number; lng: number } | null;
};

export interface LiveSnapshot {
  generatedAt: string;
  riders: LiveRider[];
  orders: LiveOrder[];
  lanes: { placed: number; kitchen: number; ready: number; on_the_way: number };
  unassigned: string[];
  delayed: { orderId: string; kind: DelayKind; minutes: number }[];
  signals: LiveSignal[];
  thresholds: {
    staleSeconds: number;
    inactiveMinutes: number;
    unassignedMinutes: number;
    prepGraceMinutes: number;
    pickupWaitMinutes: number;
  };
}

/** The code every screen prints: the first 8 characters of the id, upper-cased. */
export function orderShortCode(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export const ACTIVE_ORDER_STATUSES: readonly DbOrderStatus[] = ["placed", "kitchen", "ready", "on_the_way"];
export const TERMINAL_ORDER_STATUSES: readonly DbOrderStatus[] = ["delivered", "cancelled"];
export const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["assigned", "picked_up"];
