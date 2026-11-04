"use client";

import { useEffect, useState } from "react";

/**
 * What a tracking poll said about the customer's cancel window: the seconds the
 * database counted, and when (this device's clock) that answer arrived.
 */
export interface CancelWindowReading {
  seconds: number;
  readAt: number;
}

const secondsAfter = (r: CancelWindowReading, now: number) =>
  Math.max(0, r.seconds - Math.ceil((now - r.readAt) / 1000));

/**
 * The countdown beside the Cancel button: whole seconds left, 0 when it is over.
 *
 * This only decides what to show. The starting figure comes from the database on
 * every poll, the phone's clock only measures the time since that answer, and the
 * server decides on the tap (customer_cancel_order, 0191), so a wrong clock can
 * show the wrong number but can't buy any time.
 */
export function useCancelCountdown(reading: CancelWindowReading | null): number {
  const [left, setLeft] = useState(() => (reading ? reading.seconds : 0));

  useEffect(() => {
    if (!reading) return;
    const tick = () => setLeft(secondsAfter(reading, Date.now()));
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [reading]);

  return reading ? left : 0;
}
