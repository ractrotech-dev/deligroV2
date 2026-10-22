"use client";

import { useState, useTransition } from "react";
import { alertDecisionAction } from "./actions";

/** Acknowledge, or resolve with a short note of what was done. */
export function AlertRowActions({ id, status }: Readonly<{ id: string; status: string }>) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (status === "resolved") return null;

  const run = (action: "acknowledge" | "resolve") =>
    start(async () => {
      setError(null);
      let note: string | null = null;
      if (action === "resolve") {
        note = window.prompt("What was done? (3–300 characters)")?.trim() ?? null;
        if (!note) return;
      }
      const r = await alertDecisionAction(id, action, note);
      if (!r.ok) setError(r.error);
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "open" ? (
        <button type="button" className="c-btn c-btn-outline press" disabled={pending} onClick={() => run("acknowledge")}>
          Acknowledge
        </button>
      ) : null}
      <button type="button" className="c-btn c-btn-outline press" disabled={pending} onClick={() => run("resolve")}>
        Resolve
      </button>
      {error ? <span className="text-xs text-deal">{error}</span> : null}
    </div>
  );
}
