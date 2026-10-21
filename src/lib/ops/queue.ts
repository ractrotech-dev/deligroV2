/**
 * The order queues (delayed, unassigned) and their counts, from the lean rows
 * of `ops_order_queue_facts` (migration 0142): one scoped, oldest-first,
 * uncapped read of the in-flight orders, no embeds. Pure, so the route and
 * scripts/qa/manager-queue-counts.ts compute them the same way.
 *
 * Also the list filter that keeps the Orders list in step with the dashboard
 * tiles: unpaid online checkouts are not orders (isCountedOrder), in either.
 */
import { COUNTED_ONLINE_PAYMENTS } from "@/lib/metrics/definitions";
import { delayFor, distanceKm, type LiveOrderFacts } from "./live-rules";
import type { DbOrderStatus } from "./order-contract";

/** One row of ops_order_queue_facts, as PostgREST returns it. */
export interface QueueFactRow {
  id: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  prep_minutes: number | null;
  zone_id: string | null;
  eta_min: number | null;
  eta_max: number | null;
  shop_lat: number | null;
  shop_lng: number | null;
  drop_lat: number | null;
  drop_lng: number | null;
  delivery_status: string | null;
  driver_id: string | null;
  picked_up_at: string | null;
  failed_at: string | null;
}

export type QueueFacts = LiveOrderFacts & { id: string; zoneId: string | null };

export function factsFromQueueRow(r: QueueFactRow): QueueFacts {
  return {
    id: r.id,
    zoneId: r.zone_id,
    status: r.status as DbOrderStatus,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    readyAt: r.ready_at,
    prepMinutes: r.prep_minutes,
    etaMin: r.eta_min,
    etaMax: r.eta_max,
    distanceKm: distanceKm({ lat: r.shop_lat, lng: r.shop_lng }, { lat: r.drop_lat, lng: r.drop_lng }),
    delivery: r.delivery_status
      ? { status: r.delivery_status, driverId: r.driver_id, pickedUpAt: r.picked_up_at, failedAt: r.failed_at }
      : null,
  };
}

/** The queue chips' numbers. */
export function queueCounts(facts: QueueFacts[], now: Date): { delayed: number; unassigned: number } {
  let delayed = 0;
  let unassigned = 0;
  for (const f of facts) {
    const d = delayFor(f, now);
    if (!d) continue;
    delayed++;
    if (d.kind === "unassigned") unassigned++;
  }
  return { delayed, unassigned };
}

/** The ids in a queue, oldest order first. */
export function queueOrderIds(facts: QueueFacts[], now: Date, queue: "delayed" | "unassigned"): string[] {
  return [...facts]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    .filter((f) => {
      const d = delayFor(f, now);
      return queue === "unassigned" ? d?.kind === "unassigned" : d !== null;
    })
    .map((f) => f.id);
}

/**
 * PostgREST `or=` filter for "this row is an order": not an online checkout,
 * or one whose payment went through. Built from the dashboard's own list, so
 * the two cannot drift.
 */
export const COUNTED_ORDER_FILTER = `payment_method.neq.online,payment_status.in.(${COUNTED_ONLINE_PAYMENTS.join(",")})`;
