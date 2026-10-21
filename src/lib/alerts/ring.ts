/**
 * The ring protocol: how the server tells a Vendor or Rider phone to start
 * ringing for an order, and to stop.
 *
 * A normal push sounds once. A kitchen with its phone in an apron pocket, or a
 * rider with theirs in a jacket, misses one sound; they do not miss a phone
 * that keeps ringing until somebody deals with the order. The payloads below
 * ride on OneSignal's `data` field and are read on Android by
 * mobile/native/DeligroNotificationExtension.java — scripts/qa/ring-protocol.ts
 * checks the key names still match.
 *
 * Pure: imported by server code and by the board components.
 */

export type RingRole = "vendor" | "rider";

/**
 * The longest a ring lasts with nobody answering. Vendor: 5 min — ops are
 * already alerted at 3 (KITCHEN_SLOW_MIN in lib/dispatch/sweep.ts) and a
 * closed kitchen must not ring all night. Rider: the exclusive offer window
 * (EXCLUSIVE_OFFER_MS in lib/dispatch/rider-dispatch.ts, pinned equal by the
 * QA script); after it the order is in the open pool and ringing one rider
 * means nothing. Since 0082 the live window is `rider_offer_window_seconds`; the
 * ring still runs for this default until the setting is passed through
 * `riderRing`, so a window changed away from 180 s is not matched by the ring.
 */
export const RING_TIMEOUT_SEC: Record<RingRole, number> = { vendor: 300, rider: 180 };

export const RING_KEYS = { action: "ring", id: "ringId", timeout: "timeoutSec", sentAt: "sentAt" } as const;

/**
 * `sentAt` is the server's clock (ms). FCM does not keep messages in order, so
 * a phone can receive a stop before its start; the app remembers the stop's
 * `sentAt` and ignores any start sent before it. Comparing two server times
 * means a wrong phone clock cannot silence a real order.
 */
export interface RingStart {
  ring: "start";
  ringId: string;
  timeoutSec: number;
  sentAt: number;
}
export interface RingStop {
  ring: "stop";
  ringId: string;
  sentAt: number;
}

export function ringId(role: RingRole, orderId: string): string {
  return `${role}:${orderId}`;
}

export function ringStartData(role: RingRole, orderId: string, timeoutSec?: number): RingStart {
  const t = Math.round(timeoutSec ?? RING_TIMEOUT_SEC[role]);
  return {
    ring: "start",
    ringId: ringId(role, orderId),
    timeoutSec: Math.min(600, Math.max(1, t)),
    sentAt: Date.now(),
  };
}

export function ringStopData(role: RingRole, orderId: string): RingStop {
  return { ring: "stop", ringId: ringId(role, orderId), sentAt: Date.now() };
}

/**
 * Whether a status move ends the vendor's ring: anything that takes an order
 * out of New (`placed`). Every path that moves an order — the kitchen, a
 * manager, an admin override — asks this, so support accepting on the
 * kitchen's behalf silences the kitchen's phone too.
 */
export function vendorRingEnds(from: string, to: string): boolean {
  return from === "placed" && to !== "placed";
}

/**
 * The rider whose ring must stop when an order is offered again: the previous
 * offeree, if it is somebody else. A heads-up at accept and a re-offer at
 * ready can go to two different riders; the first must not keep ringing for
 * an order now held for the second.
 */
export function staleOfferee(previous: string | null | undefined, next: string): string | null {
  return previous && previous !== next ? previous : null;
}
