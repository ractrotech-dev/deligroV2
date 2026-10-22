"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, BellOff, MapPin, Phone, Siren } from "lucide-react";
import { listEmergenciesAction } from "@/app/manager/support-actions";
import { useArrivalSound } from "@/components/ops/exception-queue";
import type { EmergencyItem } from "@/components/ops/emergency-types";
import { cn } from "@/lib/utils/cn";

/**
 * Rider emergencies, on top of everything (§15): every open `emergency`
 * ticket — an SOS or a safety report — red, newest first, with what an
 * operator needs to act at once: who, their rider ID, a call button, the
 * order they hold, where they are, and the ticket.
 *
 * Shared by the admin home (which does not refresh itself, so it passes
 * `poll`) and the manager board (whose AutoRefresh re-renders it). A new
 * emergency sounds the alarm tone once the operator has turned sound on —
 * the same switch as the exception queue's (`useArrivalSound`), so one tap
 * arms both. Phones are rung by push regardless (`ops:sos:<ticketId>`).
 *
 * Renders nothing when there is no emergency: an all-clear banner would be a
 * permanent red-adjacent box that people learn to ignore.
 *
 * Console rules: tokens only, sized against its container.
 */

const POLL_MS = 8_000;

function ago(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min ago`;
}

export function EmergencyBanner({
  items: initial,
  poll = false,
  basePath,
  className,
}: Readonly<{
  items: EmergencyItem[];
  poll?: boolean;
  /** Where "Open ticket" goes: the admin desk or the manager's read-only view. */
  basePath: "/admin/support" | "/manager/support";
  className?: string;
}>) {
  const [items, setItems] = useState(initial);
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setItems(initial);
  }
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    if (!poll) return () => window.clearInterval(clock);
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await listEmergenciesAction();
        if (!stopped) setItems(next);
      } catch {
        // A missed poll is the next poll's job.
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(clock);
    };
  }, [poll]);

  const sound = useArrivalSound(items.map((x) => x.id));
  if (items.length === 0) return null;

  return (
    <section
      className={cn("@container rounded-[var(--c-r)] border border-deal/40 bg-deal-soft p-3", className)}
      aria-labelledby="ops-emergencies-title"
      role="alert"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ops-emergencies-title" className="flex items-center gap-2 text-[15px] font-bold text-deal">
          <Siren className="size-4" aria-hidden="true" />
          {items.length === 1 ? "Rider emergency" : `${items.length} rider emergencies`}
        </h2>
        {sound.supported ? (
          <button
            type="button"
            onClick={sound.on ? sound.disarm : sound.arm}
            className="press inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2"
            aria-pressed={sound.on}
          >
            {sound.on ? <Bell className="size-3.5 text-accent" /> : <BellOff className="size-3.5 text-muted" />}
            {sound.on ? "Sound on" : "Sound off"}
          </button>
        ) : null}
      </div>

      <ul className="mt-2.5 grid gap-2 @3xl:grid-cols-2">
        {items.map((x) => (
          <li key={x.id} className="rounded-lg border border-deal/30 bg-surface p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-bold text-ink">
                  {x.riderName}
                  {x.riderCode ? <span className="text-data ml-1.5 text-[12px] font-semibold text-muted">{x.riderCode}</span> : null}
                </p>
                <p className="mt-0.5 text-[12.5px] font-semibold text-deal">
                  {x.categoryLabel} · #{x.number} · {ago(x.createdAt, now)}
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  {x.orderCode ? `Order ${x.orderCode}` : "No active order"}
                  {x.assigned ? " · being handled" : " · nobody has picked this up yet"}
                </p>
              </div>
              <Link href={`${basePath}/${x.id}`} className="c-btn c-btn-outline press shrink-0">
                Open ticket
              </Link>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {x.riderPhone ? (
                <a href={`tel:${x.riderPhone}`} className="c-btn c-btn-dark press inline-flex items-center gap-1.5">
                  <Phone className="size-3.5" aria-hidden="true" />
                  Call rider
                </a>
              ) : null}
              {x.locationUrl ? (
                <a
                  href={x.locationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="c-btn c-btn-outline press inline-flex items-center gap-1.5"
                >
                  <MapPin className="size-3.5" aria-hidden="true" />
                  Location
                </a>
              ) : (
                <span className="inline-flex items-center text-[12px] text-muted">Location not shared</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
