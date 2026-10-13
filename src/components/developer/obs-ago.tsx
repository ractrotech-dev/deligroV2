"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * "4m ago", and still right twenty minutes later.
 *
 * This started as a server-rendered string and had two problems, one of which
 * only shows up in the situation the whole console exists for.
 *
 *   * `Date.now()` during render is impure — the lint rule that flags it is
 *     correct, even for a `force-dynamic` page that renders once per request.
 *   * More importantly, a server-rendered "4m ago" is frozen. An incident page
 *     stays open on somebody's second monitor for an hour, and a frozen
 *     relative timestamp is worse than an absolute one: it reads as current and
 *     is not. Somebody looking at "last seen 4m ago" on a page rendered at
 *     12:04 will believe the issue is still live at 13:00.
 *
 * So the first paint is the absolute local time — which is what the server
 * renders, so hydration matches — and once mounted it becomes relative and
 * re-renders every 30 seconds. The `title` always carries the full timestamp,
 * for comparing against somebody else's screenshot.
 */
export function Ago({ iso, className }: { iso: string; className?: string }) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const date = new Date(iso);
  const text =
    now === 0
      ? date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
      : relative(date.getTime(), now);

  return (
    <time
      dateTime={iso}
      title={date.toLocaleString("en-IN")}
      className={cn(
        "text-data whitespace-nowrap text-[11.5px] text-muted",
        className
      )}
    >
      {text}
    </time>
  );
}

/* ============================================================
   One clock for the whole page
   ============================================================ */

/**
 * A single shared interval rather than one per component.
 *
 * The log viewer renders 300 of these. Three hundred `setInterval`s, each
 * waking independently, is a measurable cost on the cheap laptop this console
 * gets opened on — and they would tick out of step, so two rows a second apart
 * could disagree about what "now" is.
 *
 * `useSyncExternalStore` rather than state-in-an-effect: it is the primitive
 * built for exactly this (an external mutable source, plus a distinct server
 * snapshot for hydration), and it avoids the cascading-render pattern that
 * setting state synchronously inside an effect creates.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** 0 means "not mounted yet" — the signal to render the absolute time. */
let clock = 0;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    timer = setInterval(() => {
      clock = Date.now();
      for (const listener of listeners) listener();
    }, 30_000);
  }
  return () => {
    listeners.delete(onChange);
    // Last one out stops the clock. Without this the interval outlives every
    // observability page for the rest of the session.
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  // Lazily seeded on the first client read, then only moved by the interval —
  // so the value is stable between renders, which is what useSyncExternalStore
  // requires to avoid an infinite loop.
  if (clock === 0) clock = Date.now();
  return clock;
}

function getServerSnapshot(): number {
  return 0;
}

function relative(then: number, now: number): string {
  // Clamped at zero: a row written by a database whose clock is a second ahead
  // of the browser's must not read "in 1s".
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
