/**
 * One order as the ops data layer reads it, and its serialisation to the
 * pinned `OrderListItem`. Pure: the data layer builds `OpsOrderRow`s from the
 * database, the list, detail and live routes all serialise through here.
 */
import { delayFor, distanceKm, orderEtaView, type LiveOrderFacts } from "./live-rules";
import { orderShortCode, type DbOrderStatus, type DeliveryStatus, type OrderListItem } from "./order-contract";

export interface OpsOrderRow {
  id: string;
  status: DbOrderStatus;
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  prepMinutes: number | null;
  zoneId: string | null;
  etaMin: number | null;
  etaMax: number | null;
  vendor: { id: string; name: string; lat: number | null; lng: number | null };
  drop: { lat: number; lng: number } | null;
  customerName: string | null;
  total: number;
  itemCount: number;
  payment: { method: string | null; status: string | null };
  byPhone: boolean;
  delivery: { status: string; driverId: string | null; pickedUpAt: string | null; failedAt: string | null } | null;
  riderName: string | null;
  riderCode: string | null;
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  cancelledAt?: string | null;
}

export function liveFacts(row: OpsOrderRow): LiveOrderFacts {
  return {
    status: row.status,
    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt,
    readyAt: row.readyAt,
    prepMinutes: row.prepMinutes,
    etaMin: row.etaMin,
    etaMax: row.etaMax,
    distanceKm: distanceKm(row.vendor, row.drop),
    delivery: row.delivery,
  };
}

function riderOf(row: OpsOrderRow): OrderListItem["rider"] {
  const d = row.delivery;
  if (!d?.driverId || d.status === "unassigned" || d.status === "cancelled") return null;
  return { id: d.driverId, name: row.riderName ?? "Rider", code: row.riderCode };
}

export function toOrderListItem(row: OpsOrderRow, now: Date): OrderListItem {
  const facts = liveFacts(row);
  return {
    id: row.id,
    code: orderShortCode(row.id),
    status: row.status,
    createdAt: row.createdAt,
    zoneId: row.zoneId,
    vendor: { id: row.vendor.id, name: row.vendor.name },
    customerName: row.customerName,
    total: row.total,
    itemCount: row.itemCount,
    payment: row.payment,
    rider: riderOf(row),
    deliveryStatus: (row.delivery?.status as DeliveryStatus | undefined) ?? null,
    byPhone: row.byPhone,
    eta: orderEtaView(facts, now),
    delay: delayFor(facts, now),
    cancellation:
      row.status === "cancelled"
        ? { by: row.cancelledBy ?? null, reason: row.cancellationReason ?? null, at: row.cancelledAt ?? null }
        : null,
  };
}
