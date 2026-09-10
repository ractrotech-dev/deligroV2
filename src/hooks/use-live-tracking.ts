"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderStatus, Rider } from "@/types";
import {
  computeRiderPosition,
  type TrackPoint,
} from "@/lib/tracking/rider-position";
import type { OrderEta } from "@/lib/orders/eta";
import type { RiderPositionSource } from "@/lib/data-access/order-tracking";
import { DEFAULT_CENTER } from "@/lib/maps/config";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isOrderInFlight } from "@/lib/utils/order-status";

export interface LiveTrackingState {
  status: OrderStatus;
  /**
   * The server's estimate, recomputed on every poll. Null until the first one
   * lands (or forever, on a mock order) — the view falls back to the
   * restaurant's advertised band and says nothing it can't support.
   */
  eta: OrderEta | null;
  rider: Rider | null;
  /** The shop's pin, or null when the vendor has never set one. */
  restaurant: TrackPoint | null;
  destination: TrackPoint;
  riderPosition: TrackPoint | null;
  riderPositionSource: RiderPositionSource;
}

/**
 * How the last few polls have gone.
 *
 * The poll used to discard every failure — `if (!res.ok) return;` and a `catch`
 * that kept the last snapshot — so an expired session, a tripped rate limit or a
 * backend fault left a screen that looked live and was frozen. Combined with the
 * local pin recomputation (which needs no poll to keep running), a customer
 * could watch a courier advance toward their door for minutes while nothing at
 * all had been received.
 *
 * `stale` is the signal the view needs: keep showing the last known state,
 * because it is still the best thing we know, but stop presenting it as current.
 */
export interface TrackingHealth {
  /** Consecutive failed polls. 0 once one succeeds. */
  failures: number;
  /** Nothing has been confirmed for long enough that the screen should say so. */
  stale: boolean;
  /** Whether the customer needs to sign in again — a failure they can act on. */
  unauthorized: boolean;
  /** ms since the last successful poll, or null before the first one. */
  ageMs: number | null;
}

/**
 * Two misses before we say anything. One dropped request on a phone changing
 * cells is normal and self-corrects on the next tick 3s later; announcing it
 * would make the screen cry wolf every time someone walks into a lift.
 */
const STALE_AFTER_FAILURES = 3;

interface TrackingInterp {
  orderStatus: string;
  deliveryStatus: string | null;
  assignedAt: string | null;
  pickedUpAt: string | null;
  storedRider: (TrackPoint & { at: string | null }) | null;
  /** The road leg, in minutes — how long the pin should take to cross it. */
  rideMinutes: number;
}

export function useLiveTracking(
  orderId: string,
  initial: {
    status: OrderStatus;
    eta?: OrderEta | null;
    rider?: Rider | null;
  }
) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(orderId);
  const [tracking, setTracking] = useState<LiveTrackingState>({
    status: initial.status,
    eta: initial.eta ?? null,
    rider: initial.rider ?? null,
    // Null, not a placeholder near the city centre. This seeded the SAME
    // fabricated offset the server used to substitute for an unpinned shop, so
    // the first paint drew a route line out of a made-up point even for orders
    // whose shop is properly pinned — it was replaced only when the first poll
    // landed. Nothing is drawn until a real pin arrives.
    restaurant: null,
    destination: DEFAULT_CENTER,
    riderPosition: null,
    // Nothing has been reported yet, and there is no pin to describe.
    riderPositionSource: "none",
  });
  const [interp, setInterp] = useState<TrackingInterp | null>(null);
  // Seeded with the current time rather than 0, so the very first render can
  // place the rider without reading the clock during render (impure: two renders
  // in the same commit could disagree). The interval below advances it.
  const [tick, setTick] = useState(() => Date.now());

  const [health, setHealth] = useState<TrackingHealth>({
    failures: 0,
    stale: false,
    unauthorized: false,
    ageMs: null,
  });
  /** Wall-clock of the last good poll; drives `ageMs` without re-rendering. */
  const lastOk = useRef<number | null>(null);

  const recordFailure = useCallback((unauthorized: boolean) => {
    setHealth((prev) => {
      const failures = prev.failures + 1;
      return {
        failures,
        stale: failures >= STALE_AFTER_FAILURES,
        // Sticky: a 401 does not fix itself by retrying, and the customer needs
        // to be told to sign in rather than watch a spinner.
        unauthorized: prev.unauthorized || unauthorized,
        ageMs: lastOk.current === null ? null : Date.now() - lastOk.current,
      };
    });
  }, []);

  const poll = useCallback(async () => {
    if (!isSupabaseConfigured || !isUuid) return;
    try {
      const res = await fetch(`/api/orders/${orderId}/tracking`, {
        cache: "no-store",
      });
      if (!res.ok) {
        // Was `return` — every 401, 429, 500 and network fault silently
        // discarded, leaving the screen confidently rendering a snapshot that
        // might be minutes old.
        recordFailure(res.status === 401);
        return;
      }
      const data = await res.json();
      if (data.tracking) {
        lastOk.current = Date.now();
        setHealth({ failures: 0, stale: false, unauthorized: false, ageMs: 0 });
        const t = data.tracking;
        setTracking({
          status: t.status,
          eta: t.eta ?? null,
          rider: t.rider,
          restaurant: t.restaurant,
          destination: t.destination,
          riderPosition: t.riderPosition,
          // Absent means an older payload, which we must read as "not proven
          // live" rather than as a claim of GPS.
          riderPositionSource: t.riderPositionSource ?? "estimated",
        });
        if (t.interp) setInterp(t.interp);
      } else {
        // 200 with nothing in it is still a poll that told us nothing.
        recordFailure(false);
      }
    } catch {
      // Keep the last snapshot — it remains the best thing we know — but count
      // the miss, so the view can stop claiming it is current.
      recordFailure(false);
    }
  }, [orderId, isUuid, recordFailure]);

  useEffect(() => {
    if (!isSupabaseConfigured || !isUuid) return;
    // Nothing left to track once the order is delivered or cancelled — polling
    // past that point just hammers the endpoint forever for as long as the
    // customer leaves this tab open. Re-evaluated on every status change
    // (rather than checked once) so the poll that reports the terminal status
    // is also the one that stops scheduling the next one.
    if (!isOrderInFlight(tracking.status)) return;

    // The first read is scheduled rather than called inline. poll() only touches
    // state after awaiting the fetch, but an effect body calling it directly
    // reads as a synchronous setState — so it goes through a timer, the same
    // "callback from an external system" shape as the interval below. A 0ms
    // delay, so the first snapshot still lands on the first frame.
    const first = setTimeout(() => void poll(), 0);
    const id = setInterval(() => {
      if (!document.hidden) void poll();
    }, 3000);
    const onFocus = () => void poll();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [poll, isUuid, tracking.status]);

  // Recompute the pin on the same 3s cadence as the poll that feeds it.
  //
  // This used to run every 400ms, and the comment said why: "so movement feels
  // live between GPS polls". Between polls there is no new information — the
  // extra frames animated an interpolation, i.e. they were there to make an
  // estimate look like a live feed. At the poll cadence the pin still updates
  // promptly when a real fix lands, and stops performing smoothness it hasn't
  // got. Nothing on this screen updates faster than the data behind it.
  //
  // Frozen once the poll goes stale, and that is the important half. The
  // interpolation runs entirely off `interp` and the clock — it needs no data at
  // all — so a screen that had stopped hearing from the server kept walking the
  // courier toward the customer's door regardless. If we don't know anything
  // new, the pin doesn't move.
  useEffect(() => {
    if (!interp || health.stale || !isOrderInFlight(tracking.status)) return;
    const id = setInterval(() => {
      if (!document.hidden) setTick(Date.now());
    }, 3000);
    return () => clearInterval(id);
  }, [interp, health.stale, tracking.status]);

  const animatedRider =
    interp && tracking.restaurant && tracking.destination
      ? computeRiderPosition({
          orderStatus: interp.orderStatus,
          deliveryStatus: interp.deliveryStatus,
          assignedAt: interp.assignedAt,
          pickedUpAt: interp.pickedUpAt,
          restaurant: tracking.restaurant,
          destination: tracking.destination,
          storedRider: interp.storedRider,
          // The road leg, not the door-to-door promise — see order-tracking.ts.
          etaMinutes: interp.rideMinutes,
          now: tick,
        })
      : tracking.riderPosition;

  const riderPosition = animatedRider ?? tracking.riderPosition;

  return {
    ...tracking,
    health,
    riderPosition,
    // The server decided this label against the same 45s window
    // `computeRiderPosition` uses, and we re-poll every 3s — so it can only ever
    // be a few seconds behind the pin it describes, and only in the direction of
    // claiming GPS a moment after the fix went stale. Any position we have
    // invented locally, without a snapshot to back it, is never "gps".
    riderPositionSource: riderPosition
      ? tracking.riderPositionSource === "none"
        ? "estimated"
        : tracking.riderPositionSource
      : "none",
  };
}
