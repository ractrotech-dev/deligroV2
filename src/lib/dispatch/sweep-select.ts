/**
 * Which rows the dispatch sweep acts on — the rules, with no database.
 *
 * Pure on purpose (no `server-only`): `scripts/qa/rider-offers.ts` runs it under
 * tsx, and `sweep.ts` is the thin wrapper that reads the rows, asks this, and
 * performs the writes. Keeping the decision here is what lets "19:59 stays,
 * 20:01 goes" be a test rather than a hope.
 */

/** An online rider with no fix for this long is a dead phone, not a rider. */
export const PRESENCE_TIMEOUT_MS = 20 * 60_000;

/**
 * A ready order is dispatched by the transition itself; the sweep only picks up
 * what that missed. Without this grace the two would race on a brand-new order
 * and could offer it to two riders.
 */
export const NEVER_OFFERED_GRACE_MS = 60_000;

export interface PresenceRow {
  driverId: string;
  isOnline: boolean;
  lastFixAt: string | null;
  onlineSince: string | null;
  /** The rider is carrying a delivery. Such a rider is never taken offline. */
  hasActiveDelivery: boolean;
}

function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Riders to force offline, and when their shift ended.
 *
 * Presence is counted from the last fix, or from `online_since` when the shift
 * never produced one. Age is absolute: a phone whose clock runs ahead reports
 * fixes "from the future" that must not keep a rider online for ever. An online
 * row with neither timestamp has nothing proving presence at all: it goes, with
 * `endedAt` null (the shift is then closed at its own start, a zero-length
 * record rather than hours nobody worked).
 */
export function presenceExpired(
  rows: PresenceRow[],
  now: Date
): { driverId: string; endedAt: string | null }[] {
  const nowMs = now.getTime();
  const out: { driverId: string; endedAt: string | null }[] = [];
  for (const row of rows) {
    if (!row.isOnline || row.hasActiveDelivery) continue;
    const fix = instant(row.lastFixAt);
    const since = instant(row.onlineSince);
    const reference = fix ?? since;
    if (reference === null) {
      out.push({ driverId: row.driverId, endedAt: null });
    } else if (Math.abs(nowMs - reference) >= PRESENCE_TIMEOUT_MS) {
      out.push({
        driverId: row.driverId,
        endedAt: fix !== null ? row.lastFixAt : row.onlineSince,
      });
    }
  }
  return out;
}

export interface RedispatchRow {
  orderId: string;
  orderStatus: string;
  readyAt: string | null;
  /** Null when the order has no delivery row yet. */
  deliveryStatus: string | null;
  offeredDriverId: string | null;
  offeredAt: string | null;
}

export type RedispatchKind =
  /** An offer was made and its window ran out unanswered. */
  | "lapsed"
  /** Ready, and nobody has ever been offered it (or the offer was withdrawn by a rejection). */
  | "never_offered";

export interface RedispatchTarget {
  orderId: string;
  kind: RedispatchKind;
  /** The rider who let the offer lapse; null for never-offered. */
  lapsedDriverId: string | null;
}

/**
 * The ready orders the sweep should offer again.
 *
 * Only `ready` orders, and only while the delivery is still up for grabs
 * (`unassigned`, or no row at all). A standing offer inside its window is left
 * alone; one past it is `lapsed`; one that was never made is `never_offered`
 * once the order has been ready for a minute. An offer with no timestamp cannot
 * be measured against a window, so it counts as lapsed rather than waiting for
 * ever.
 */
export function redispatchTargets(
  rows: RedispatchRow[],
  now: Date,
  windowSeconds: number
): RedispatchTarget[] {
  const nowMs = now.getTime();
  const out: RedispatchTarget[] = [];
  for (const row of rows) {
    if (row.orderStatus !== "ready") continue;
    if (row.deliveryStatus !== null && row.deliveryStatus !== "unassigned") continue;

    if (!row.offeredDriverId) {
      const ready = instant(row.readyAt);
      if (ready !== null && nowMs - ready < NEVER_OFFERED_GRACE_MS) continue;
      out.push({ orderId: row.orderId, kind: "never_offered", lapsedDriverId: null });
      continue;
    }

    const offered = instant(row.offeredAt);
    if (offered === null || nowMs - offered >= windowSeconds * 1000) {
      out.push({ orderId: row.orderId, kind: "lapsed", lapsedDriverId: row.offeredDriverId });
    }
  }
  return out;
}
