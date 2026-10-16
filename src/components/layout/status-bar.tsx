"use client";

import { useEffect, useState } from "react";

/**
 * Simulated iOS status bar for the desktop phone preview — the real thing is
 * drawn by iOS itself, so on an actual phone (below the frame breakpoint) CSS
 * hides this entirely.
 *
 * Time is the viewer's real clock, formatted the way iOS does it: 12-hour, no
 * leading zero, no AM/PM. It's client-only (a server-rendered time would be the
 * server's clock and would hydrate-mismatch), so the slot renders empty for the
 * first paint — it has a fixed width, so nothing shifts when it fills in.
 */
function useClock() {
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
          .replace(/\s?[AP]M$/i, "")
      );
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  return time;
}

/** Four bars, tallest last — iOS shows all four filled at full signal. */
function CellularIcon() {
  return (
    <svg viewBox="0 0 18 12" className="status-bar-icon" style={{ width: 17 }} aria-hidden>
      {[0, 1, 2, 3].map((i) => {
        const height = 4 + i * 2.4;
        return (
          <rect
            key={i}
            x={i * 4.7}
            y={12 - height}
            width={3.2}
            height={height}
            rx={1.1}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}

/** Three arcs above a dot — stroked with round caps, as iOS draws it. */
function WifiIcon() {
  return (
    <svg viewBox="0 0 16 12" className="status-bar-icon" style={{ width: 16 }} aria-hidden>
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      >
        <path d="M1.4 4.4a9.5 9.5 0 0 1 13.2 0" />
        <path d="M4.1 7.2a5.7 5.7 0 0 1 7.8 0" />
      </g>
      <circle cx={8} cy={10.2} r={1.35} fill="currentColor" />
    </svg>
  );
}

/** Rounded body + terminal nub, filled to `level` (0–1). */
function BatteryIcon({ level = 0.82 }: Readonly<{ level?: number }>) {
  const inner = 21 * Math.min(Math.max(level, 0), 1);
  return (
    <svg viewBox="0 0 27 13" className="status-bar-icon" style={{ width: 26 }} aria-hidden>
      <rect
        x={0.6}
        y={0.6}
        width={23.3}
        height={11.8}
        rx={3.6}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.38}
        strokeWidth={1.1}
      />
      <path
        d="M25.4 4.6c.9.3 1.3 1 1.3 1.9s-.4 1.6-1.3 1.9V4.6Z"
        fill="currentColor"
        fillOpacity={0.42}
      />
      <rect
        x={2.2}
        y={2.2}
        width={inner}
        height={8.6}
        rx={2.1}
        fill="currentColor"
      />
    </svg>
  );
}

export function StatusBar() {
  const time = useClock();

  return (
    <div className="status-bar" aria-hidden>
      <span className="status-bar-time">{time}</span>
      <span className="status-bar-icons">
        <CellularIcon />
        <WifiIcon />
        <BatteryIcon />
      </span>
    </div>
  );
}
