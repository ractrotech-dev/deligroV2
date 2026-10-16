"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Connection state, as the UI needs it.
 *
 * `navigator.onLine` is the only signal every browser agrees on, and it is a
 * weak one — it means "there is a network interface", not "the internet is
 * reachable". That is fine for what this drives: a subtle indicator and a
 * refresh on recovery, neither of which is load-bearing. Nothing here gates a
 * write; the server still decides whether a request succeeds.
 */

type ConnectionState = "online" | "offline";

interface NetworkInformation extends EventTarget {
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  saveData?: boolean;
}

function connection(): NetworkInformation | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
}

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function subscribeQuality(callback: () => void): () => void {
  const conn = connection();
  // Network Information is Chromium-only. Everywhere else this is a no-op
  // subscription and `slow` simply stays false.
  if (!conn) return () => {};
  conn.addEventListener("change", callback);
  return () => conn.removeEventListener("change", callback);
}

function qualitySnapshot(): boolean {
  const conn = connection();
  if (!conn) return false;
  const type = conn.effectiveType;
  return Boolean(conn.saveData) || type === "2g" || type === "slow-2g";
}

export interface Connection {
  state: ConnectionState;
  online: boolean;
  /** True on 2g/slow-2g, or when the user has asked for reduced data. */
  slow: boolean;
  /** Timestamp of the last offline→online transition. A cue to refetch. */
  recoveredAt: number;
}

export function useConnection(): Connection {
  // Server snapshot is `true`: rendering an offline warning during SSR would
  // flash it at everyone on first paint, and the real value arrives a tick later.
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  );
  const slow = useSyncExternalStore(subscribeQuality, qualitySnapshot, () => false);

  const [recoveredAt, setRecoveredAt] = useState(0);

  // Set from the event callback, not from the effect body — the transition is
  // the thing worth reacting to, and only the browser can tell us it happened.
  useEffect(() => {
    const onOnline = () => setRecoveredAt(Date.now());
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  return { state: online ? "online" : "offline", online, slow, recoveredAt };
}
