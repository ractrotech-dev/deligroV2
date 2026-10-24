"use client";

import { useState, useTransition } from "react";
import type { AlertRule } from "@/lib/ops/alerts-contract";
import { resetRuleAction, saveRuleAction } from "@/app/admin/alerts/actions";

const UNIT_LABEL: Record<string, string> = { minutes: "min", percent: "%", ratio: "× riders", rupees: "₹" };

/** One rule: on/off, the threshold in its unit, the window where it has one; save or go back to the default. */
export function RuleEditor({ rule, zoneId }: Readonly<{ rule: AlertRule; zoneId: string | null }>) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [threshold, setThreshold] = useState(rule.threshold === null ? "" : String(rule.threshold));
  const [windowMinutes, setWindowMinutes] = useState(rule.windowMinutes === null ? "" : String(rule.windowMinutes));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setMessage(null);
      const r = await saveRuleAction({
        kind: rule.kind,
        zoneId,
        enabled,
        threshold: rule.unit === "none" || threshold === "" ? null : Number(threshold),
        windowMinutes: windowMinutes === "" ? null : Number(windowMinutes),
      });
      setMessage(r.ok ? "Saved." : r.error);
    });
  const reset = () =>
    start(async () => {
      if (!zoneId) return;
      setMessage(null);
      const r = await resetRuleAction(rule.kind, zoneId);
      setMessage(r.ok ? "Back to the default." : r.error);
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={pending} />{" "}
        On
      </label>
      {rule.unit !== "none" ? (
        <label className="flex items-center gap-1 text-sm">
          <input
            type="number"
            inputMode="decimal"
            className="c-field w-24 text-data tabular-nums"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            disabled={pending}
            aria-label={`${rule.label} threshold`}
          />
          <span className="text-muted">{UNIT_LABEL[rule.unit] ?? ""}</span>
        </label>
      ) : null}
      {rule.windowMinutes !== null ? (
        <label className="flex items-center gap-1 text-sm">
          <span className="text-muted">over</span>
          <input
            type="number"
            className="c-field w-20 text-data tabular-nums"
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(e.target.value)}
            disabled={pending}
            aria-label={`${rule.label} window in minutes`}
          />
          <span className="text-muted">min</span>
        </label>
      ) : null}
      <button type="button" className="c-btn c-btn-outline press" onClick={save} disabled={pending}>
        Save
      </button>
      {zoneId && !rule.inherited ? (
        <button type="button" className="c-btn c-btn-quiet press" onClick={reset} disabled={pending}>
          Use default
        </button>
      ) : null}
      {message ? <span className="text-xs text-muted">{message}</span> : null}
    </div>
  );
}
