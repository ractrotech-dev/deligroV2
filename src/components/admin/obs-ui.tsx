import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { SEVERITY_LABEL } from "@/lib/obs/severity";
import type { ObsSeverity } from "@/lib/obs/types";
import type { HealthState } from "@/lib/obs/metrics";
import type { ObsEventRowRead } from "@/lib/obs/read";
import { Ago } from "./obs-ago";

/**
 * Presentational pieces for the observability console.
 *
 * Everything here is a server component and reuses the existing admin kit's
 * tokens (`--line`, `--surface`, `text-muted`, `text-data`), so it inherits
 * dark mode and the console's density without a second design system.
 *
 * The one thing this file adds that the rest of the admin did not need: a
 * *semantic* colour scale separate from the brand palette. Severity has to read
 * pre-attentively — an operator scanning a list during an incident is looking
 * for red before they are reading words — so it is encoded in colour AND in a
 * dot AND in the label, rather than in colour alone.
 */

/* ============================================================
   Severity
   ============================================================ */

/* ============================================================
   Why these are tokens and not Tailwind palette colours
   ============================================================
   Every tint below is `var(--deal-soft)` / `var(--c-tint-amber)` / … rather
   than `bg-red-500/12` and `text-deal`.

   The `dark:` variant is not configured in this project, so it falls back to
   Tailwind's default — `@media (prefers-color-scheme: dark)`, the *operating
   system's* setting. That is unrelated to `data-theme` (the app's own toggle)
   and unrelated to `data-console` (the console's). Which meant an operator
   running the dark console on a machine set to light mode got `text-blue-800`
   on a near-black ground: about 2:1, effectively unreadable.

   The console tokens follow `data-console`, which is the thing that actually
   decides what these sit on. Same discipline as the rest of the console, and
   the reason `@theme inline` compiles the colour utilities to variables in the
   first place.
   ------------------------------------------------------------ */

const SEVERITY_STYLES: Record<ObsSeverity, string> = {
  critical: "text-deal bg-deal-soft border-deal/30",
  high: "text-[color:var(--c-ink-amber)] bg-[var(--c-tint-amber)] border-pop/30",
  medium: "text-blue bg-[var(--c-tint-blue)] border-blue/25",
  low: "text-muted bg-[var(--c-divider)] border-line",
  info: "text-muted bg-[var(--c-divider)] border-line",
};

export function SeverityPill({
  severity,
  manual,
}: {
  severity: ObsSeverity;
  /** An operator set this by hand. Marked, so nobody wonders why it disagrees. */
  manual?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em]",
        SEVERITY_STYLES[severity]
      )}
    >
      <span className="size-[5px] rounded-full bg-current" aria-hidden />
      {SEVERITY_LABEL[severity]}
      {manual ? <span className="font-normal opacity-70">· set</span> : null}
    </span>
  );
}

/* ============================================================
   Issue status
   ============================================================ */

const STATUS_STYLES: Record<string, string> = {
  open: "text-ink bg-[var(--c-divider)] border-line",
  investigating: "text-blue bg-[var(--c-tint-blue)] border-blue/25",
  // Deliberately loud. A resolved issue that came back is worse news than one
  // that was never fixed, and it must not read as a quiet variant of "open".
  regressed: "text-deal bg-deal-soft border-deal/30",
  resolved: "text-green bg-green-soft border-green/25",
  ignored: "text-muted bg-[var(--c-divider)] border-line",
  detected: "text-[color:var(--c-ink-amber)] bg-[var(--c-tint-amber)] border-pop/30",
  identified: "text-blue bg-[var(--c-tint-blue)] border-blue/25",
  mitigating: "text-blue bg-[var(--c-tint-blue)] border-blue/25",
  closed: "text-muted bg-[var(--c-divider)] border-line",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em]",
        STATUS_STYLES[status] ?? STATUS_STYLES.open
      )}
    >
      {status}
    </span>
  );
}

/* ============================================================
   Log levels
   ============================================================ */

const LEVEL_STYLES: Record<string, string> = {
  fatal: "text-deal",
  error: "text-deal",
  warn: "text-[color:var(--c-ink-amber)]",
  info: "text-muted",
  debug: "text-muted opacity-70",
};

export function LevelTag({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "text-data w-[42px] shrink-0 text-[10.5px] font-bold uppercase tracking-[0.05em]",
        LEVEL_STYLES[level] ?? "text-muted"
      )}
    >
      {level}
    </span>
  );
}

/* ============================================================
   Health
   ============================================================ */

const HEALTH_STYLES: Record<HealthState, { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-green", text: "text-green", label: "Operational" },
  degraded: {
    dot: "bg-pop",
    text: "text-[color:var(--c-ink-amber)]",
    label: "Degraded",
  },
  down: { dot: "bg-deal", text: "text-deal", label: "Down" },
  // Distinct from both. A probe that failed is not a pass, and a service nobody
  // configured is not an outage — colouring either of them green or red is how
  // a status board stops meaning anything.
  unknown: { dot: "bg-[var(--c-faint)]", text: "text-muted", label: "Unknown" },
  off: { dot: "bg-[var(--c-faint)] opacity-50", text: "text-muted", label: "Not configured" },
};

export function HealthDot({ state }: { state: HealthState }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", HEALTH_STYLES[state].dot)}
      aria-hidden
    />
  );
}

export function HealthLine({
  label,
  state,
  detail,
  note,
}: {
  label: string;
  state: HealthState;
  detail: string;
  note?: string;
}) {
  const style = HEALTH_STYLES[state];
  return (
    <li className="flex items-start gap-2.5 border-b border-line/60 py-2 last:border-0">
      <span className="mt-[7px]">
        <HealthDot state={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-[13px] font-semibold text-ink">{label}</span>
          <span className={cn("text-[12px] font-medium", style.text)}>
            {style.label}
          </span>
        </span>
        <span className="mt-0.5 block text-[12px] text-muted">{detail}</span>
        {note ? (
          <span className="mt-0.5 block text-[11px] italic text-muted opacity-80">
            {note}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/* ============================================================
   Numbers and time
   ============================================================ */

/** A figure with its label. Tabular so a column of them lines up. */
export function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "bad" | "warn" | "good";
}) {
  return (
    <div className="min-w-0 flex-1 basis-40 bg-surface px-[15px] pb-3 pt-3.5">
      <p className="text-[11.5px] font-semibold leading-tight text-muted">{label}</p>
      <p
        className={cn(
          "mt-1.5 truncate text-[26px] font-bold leading-none tracking-[-0.03em] tabular-nums",
          tone === "bad"
            ? "text-deal"
            : tone === "warn"
              ? "text-[color:var(--c-ink-amber)]"
              : tone === "good"
                ? "text-green"
                : "text-ink"
        )}
      >
        {value}
      </p>
      {note ? <p className="mt-1.5 truncate text-[11.5px] text-muted">{note}</p> : null}
    </div>
  );
}

export function FigureStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border border-line bg-[var(--line)]">
      {children}
    </div>
  );
}

/**
 * Relative timestamps live in their own client module (`obs-ago.tsx`) and are
 * re-exported here so callers have one import.
 *
 * They have to be a client component: a server-rendered "4m ago" is frozen at
 * the moment the page was built, and an incident page sits open for an hour. A
 * stale relative time is worse than an absolute one because it still reads as
 * current. See that file for the full reasoning.
 */
export { Ago };

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

/* ============================================================
   Code and stack
   ============================================================ */

/**
 * A stack trace, with our own frames emphasised.
 *
 * The first frame inside `src/` is what to open, and in a stack that is mostly
 * framework internals it is easy to miss. Dependency frames are dimmed rather
 * than hidden — a throw from inside the Supabase client is a real diagnosis, and
 * collapsing it would hide the evidence for it.
 */
export function StackViewer({ stack }: { stack: string }) {
  const lines = stack.split("\n");
  return (
    <pre className="text-data overflow-x-auto rounded-lg border border-line bg-[var(--surface-2,var(--line))]/30 p-3 text-[11.5px] leading-[1.65]">
      {lines.map((line, i) => {
        const ours =
          line.includes("/src/") &&
          !line.includes("node_modules") &&
          !line.includes("/.next/");
        return (
          <div
            key={i}
            className={cn(
              "whitespace-pre",
              i === 0
                ? "font-semibold text-ink"
                : ours
                  ? "text-ink"
                  : "text-muted opacity-65"
            )}
          >
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/** Structured attributes, rendered as key/value rather than a JSON blob. */
export function AttrGrid({ attrs }: { attrs: Record<string, unknown> }) {
  const entries = Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-data text-muted">{k}</dt>
          <dd className="text-data min-w-0 break-all text-ink">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ============================================================
   Event row — shared by the log viewer and the issue timeline
   ============================================================ */

export function EventRow({
  event,
  showTrace = true,
}: {
  event: ObsEventRowRead;
  showTrace?: boolean;
}) {
  return (
    <li className="border-b border-line/60 px-3 py-2 last:border-0">
      <div className="flex items-baseline gap-2">
        <LevelTag level={event.level} />
        <Ago iso={event.occurredAt} className="w-[68px] shrink-0" />
        <span className="text-data shrink-0 text-[11.5px] text-muted">
          {event.source}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
          {event.message}
        </span>
        {event.durationMs !== null ? (
          <span className="text-data shrink-0 text-[11.5px] tabular-nums text-muted">
            {ms(event.durationMs)}
          </span>
        ) : null}
        {event.httpStatus ? (
          <span
            className={cn(
              "text-data shrink-0 text-[11.5px] font-semibold tabular-nums",
              event.httpStatus >= 500
                ? "text-deal"
                : event.httpStatus >= 400
                  ? "text-[color:var(--c-ink-amber)]"
                  : "text-muted"
            )}
          >
            {event.httpStatus}
          </span>
        ) : null}
      </div>
      {showTrace && (event.traceId || event.orderId) ? (
        <div className="mt-1 flex flex-wrap items-center gap-3 pl-[110px]">
          {event.traceId ? (
            <Link
              href={`/admin/observability/traces/${event.traceId}`}
              className="text-data text-[11px] text-muted underline underline-offset-2 hover:text-ink"
            >
              {event.traceId}
            </Link>
          ) : null}
          {event.orderId ? (
            <Link
              href={`/admin/orders/${event.orderId}`}
              className="text-data text-[11px] text-muted underline underline-offset-2 hover:text-ink"
            >
              order {event.orderId.slice(0, 8).toUpperCase()}
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ============================================================
   Notices
   ============================================================ */

/**
 * The migration is not applied.
 *
 * Shown instead of an empty dashboard, because an empty observability page and
 * a healthy platform look identical, and an operator will read the first as the
 * second. This is the same reason `console-health.ts` reports "not configured"
 * rather than a green tick.
 */
export function NotMigratedNotice() {
  return (
    <div className="rounded-[var(--c-r)] border border-pop/40 bg-[var(--c-tint-amber)] px-3.5 py-3">
      <p className="text-sm font-semibold text-ink">
        Observability is not installed on this database
      </p>
      <p className="mt-1 text-[13px] text-muted">
        Apply{" "}
        <code className="text-data">supabase/migrations/0046_observability.sql</code>,
        then schedule the four <code className="text-data">pg_cron</code> jobs listed at
        the foot of that file. Until then nothing is being recorded — this page is
        empty because there is no data, not because there is nothing wrong.
      </p>
    </div>
  );
}

/** A figure whose meaning is bounded by retention. Says so, rather than implying "ever". */
export function WindowNote({ days }: { days: number }) {
  return (
    <span className="text-[11px] italic text-muted">
      counted over the last {days} days — raw events expire, the occurrence count
      does not
    </span>
  );
}

/* ============================================================
   Metric table — endpoints, providers, domain checkpoints
   ============================================================ */

export interface MetricTableRow {
  key: string;
  count: number;
  errorCount: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/**
 * The same five columns for every dimension, because the question is the same
 * one: how much, how much of it failed, and how slow was the worst of it.
 *
 * Error rate carries a colour and volume does not. A 100% failure rate on one
 * call is not an outage, and a table that reddens it teaches an operator to
 * distrust red — so the row's tone is set by rate AND volume together, and the
 * count sits next to it so the judgement is available at a glance.
 */
export function MetricTable({
  rows,
  keyHeader,
  hrefFor,
  emptyNote,
}: {
  rows: MetricTableRow[];
  keyHeader: string;
  hrefFor?: (key: string) => string;
  emptyNote: string;
}) {
  if (!rows.length) {
    return <p className="py-3 text-[13px] text-muted">{emptyNote}</p>;
  }
  const nf = new Intl.NumberFormat("en-IN");
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="py-1.5 pl-1 pr-3 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
              {keyHeader}
            </th>
            {["Calls", "Errors", "Error rate", "p50", "p95", "p99"].map((h) => (
              <th
                key={h}
                className="py-1.5 pl-3 text-right text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // Both conditions, deliberately. Rate alone reddens a single failed
            // call; volume alone reddens a busy healthy endpoint.
            const bad = r.errorRate >= 5 && r.count >= 20;
            const warn = !bad && r.errorRate >= 1 && r.count >= 20;
            return (
              <tr key={r.key} className="border-b border-line/50 last:border-0">
                <td className="text-data max-w-[280px] truncate py-1.5 pl-1 pr-3 text-ink">
                  {hrefFor ? (
                    <Link
                      href={hrefFor(r.key)}
                      className="underline underline-offset-2"
                    >
                      {r.key}
                    </Link>
                  ) : (
                    r.key
                  )}
                </td>
                <td className="text-data py-1.5 pl-3 text-right tabular-nums text-muted">
                  {nf.format(r.count)}
                </td>
                <td className="text-data py-1.5 pl-3 text-right tabular-nums text-muted">
                  {nf.format(r.errorCount)}
                </td>
                <td
                  className={cn(
                    "text-data py-1.5 pl-3 text-right font-semibold tabular-nums",
                    bad
                      ? "text-deal"
                      : warn
                        ? "text-[color:var(--c-ink-amber)]"
                        : "text-muted"
                  )}
                >
                  {r.errorRate.toFixed(1)}%
                </td>
                <td className="text-data py-1.5 pl-3 text-right tabular-nums text-muted">
                  {ms(r.p50)}
                </td>
                <td className="text-data py-1.5 pl-3 text-right tabular-nums text-ink">
                  {ms(r.p95)}
                </td>
                <td className="text-data py-1.5 pl-3 text-right tabular-nums text-muted">
                  {ms(r.p99)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
