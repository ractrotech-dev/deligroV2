import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { SEVERITY_LABEL } from "@/lib/obs/severity";
import type { ObsSeverity } from "@/lib/obs/types";
import type { HealthState } from "@/lib/obs/metrics";
import type { ObsEventRowRead } from "@/lib/obs/read";
import { ChevronDown } from "lucide-react";
import { eventReport, healthCheckReport, metricsReport } from "@/lib/developer/ai-report";
import { Ago } from "./obs-ago";
import { CopyForAI } from "./copy-for-ai";

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
}: Readonly<{
  severity: ObsSeverity;
  /** An operator set this by hand. Marked, so nobody wonders why it disagrees. */
  manual?: boolean;
}>) {
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

export function StatusPill({ status }: Readonly<{ status: string }>) {
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

export function LevelTag({ level }: Readonly<{ level: string }>) {
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

function HealthDot({ state }: Readonly<{ state: HealthState }>) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", HEALTH_STYLES[state].dot)}
      aria-hidden
    />
  );
}

/** What each state means, in the words the expanded row shows. */
const HEALTH_MEANING: Record<HealthState, string> = {
  ok: "Checked and fine.",
  degraded: "Working, but slower or less reliable than it should be.",
  down: "Failing: whatever depends on this will not work.",
  unknown: "The check could not get an answer. It may be fine or broken; this page cannot tell which.",
  off: "Switched off or not set up. Not broken, just not configured.",
};

/**
 * One check. Click it to open the full reading and a "Copy for AI" report;
 * `group` and `source` (the file that computes it) go into that report.
 */
export function HealthLine({
  label,
  state,
  detail,
  note,
  group,
  source,
}: Readonly<{
  label: string;
  state: HealthState;
  detail: string;
  note?: string;
  group?: string;
  source?: string;
}>) {
  const style = HEALTH_STYLES[state];
  return (
    <li className="border-b border-line/60 last:border-0">
      <details className="group">
        <summary className="-mx-1.5 flex cursor-pointer list-none items-start gap-2.5 rounded-md px-1.5 py-2 hover:bg-[var(--line)]/20">
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
            <span className="mt-0.5 block text-[12px] text-muted group-open:hidden">{detail}</span>
            {note ? (
              <span className="mt-0.5 block text-[11px] italic text-muted opacity-80 group-open:hidden">
                {note}
              </span>
            ) : null}
          </span>
          <ChevronDown className="mt-[5px] size-3.5 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="flex flex-col gap-2.5 pb-3 pl-[18px] pt-0.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-muted">Status</dt>
            <dd className={cn("font-medium", style.text)}>
              {style.label} <span className="font-normal text-muted">— {HEALTH_MEANING[state]}</span>
            </dd>
            <dt className="text-muted">Reading</dt>
            <dd className="break-words text-ink">{detail}</dd>
            {note ? (
              <>
                <dt className="text-muted">Note</dt>
                <dd className="break-words text-ink">{note}</dd>
              </>
            ) : null}
            {group ? (
              <>
                <dt className="text-muted">Group</dt>
                <dd className="text-ink">{group}</dd>
              </>
            ) : null}
            {source ? (
              <>
                <dt className="text-muted">Checked in</dt>
                <dd className="text-data break-all text-ink">{source}</dd>
              </>
            ) : null}
          </dl>
          <div>
            <CopyForAI text={healthCheckReport({ label, state, detail, note }, { group, source })} />
          </div>
        </div>
      </details>
    </li>
  );
}

/* ============================================================
   Numbers and time
   ============================================================ */

const FIGURE_TONE: Record<"bad" | "warn" | "good", string> = {
  bad: "text-deal",
  warn: "text-[color:var(--c-ink-amber)]",
  good: "text-green",
};

/** A figure with its label. Tabular so a column of them lines up. */
export function Figure({
  label,
  value,
  note,
  tone,
}: Readonly<{
  label: string;
  value: string;
  note?: string;
  tone?: "bad" | "warn" | "good";
}>) {
  return (
    <div className="min-w-0 flex-1 basis-40 bg-surface px-[15px] pb-3 pt-3.5">
      <p className="text-[11.5px] font-semibold leading-tight text-muted">{label}</p>
      <p
        className={cn(
          "mt-1.5 truncate text-[26px] font-bold leading-none tracking-[-0.03em] tabular-nums",
          tone ? FIGURE_TONE[tone] : "text-ink"
        )}
      >
        {value}
      </p>
      {note ? <p className="mt-1.5 truncate text-[11.5px] text-muted">{note}</p> : null}
    </div>
  );
}

export function FigureStrip({ children }: Readonly<{ children: React.ReactNode }>) {
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

/** The first line is the error itself; then our frames read, library frames recede. */
function stackLineTone(index: number, ours: boolean): string {
  if (index === 0) return "font-semibold text-ink";
  if (ours) return "text-ink";
  return "text-muted opacity-65";
}

/**
 * A stack trace, with our own frames emphasised.
 *
 * The first frame inside `src/` is what to open, and in a stack that is mostly
 * framework internals it is easy to miss. Dependency frames are dimmed rather
 * than hidden — a throw from inside the Supabase client is a real diagnosis, and
 * collapsing it would hide the evidence for it.
 */
export function StackViewer({ stack }: Readonly<{ stack: string }>) {
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
            className={cn("whitespace-pre", stackLineTone(i, ours))}
          >
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/** One attribute value as text: primitives as-is, anything structured as JSON. */
function attrText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  return JSON.stringify(v) ?? "";
}

/** Structured attributes, rendered as key/value rather than a JSON blob. */
export function AttrGrid({ attrs }: Readonly<{ attrs: Record<string, unknown> }>) {
  const entries = Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-data text-muted">{k}</dt>
          <dd className="text-data min-w-0 break-all text-ink">
            {attrText(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ============================================================
   Event row — shared by the log viewer and the issue timeline
   ============================================================ */

/** Red when it is failing, amber when it is starting to, muted otherwise. */
function errorTone(bad: boolean, warn: boolean): string {
  if (bad) return "text-deal";
  if (warn) return "text-[color:var(--c-ink-amber)]";
  return "text-muted";
}

/**
 * Everything one event carries, for an opened row: the identifiers, its
 * attributes, the stack, and a "Copy for AI" report of all of it. Shared by
 * the log viewer and the issue timeline.
 */
export function EventDetail({ event: e }: Readonly<{ event: ObsEventRowRead }>) {
  const fields: [string, React.ReactNode][] = [
    ["Time", new Date(e.occurredAt).toISOString()],
    ["Kind", e.kind],
    ["Source", e.source],
    ["Message", e.message],
    ["Endpoint", e.httpRoute ? `${e.httpMethod ?? ""} ${e.httpRoute}`.trim() : null],
    ["HTTP status", e.httpStatus],
    ["Duration", e.durationMs !== null ? ms(e.durationMs) : null],
    ["Provider", e.provider],
    ["Error type", e.errorType],
    ["Fingerprint", e.errorFingerprint],
    [
      "Trace",
      e.traceId ? (
        <Link href={`/developer/observability/traces/${e.traceId}`} className="underline underline-offset-2">
          {e.traceId}
        </Link>
      ) : null,
    ],
    ["Request", e.requestId],
    ["Actor", e.actorRole ? `${e.actorRole}${e.actorId ? ` ${e.actorId}` : ""}` : null],
    [
      "Order",
      e.orderId ? (
        <Link href={`/admin/orders/${e.orderId}`} className="underline underline-offset-2">
          {e.orderId}
        </Link>
      ) : null,
    ],
    ["Restaurant", e.restaurantId],
    ["Rider", e.driverId],
    ["Environment", e.env],
    ["Release", e.release],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-[12px]">
        {fields
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="text-data min-w-0 break-all text-ink">{v}</dd>
            </div>
          ))}
      </dl>
      {(() => {
        const { steps, ...rest } = e.attrs as Record<string, unknown> & { steps?: unknown };
        return (
          <>
            {Object.keys(rest).length ? <AttrGrid attrs={rest} /> : null}
            {Array.isArray(steps) && steps.length ? (
              <div>
                <p className="mb-1 text-[11.5px] font-semibold text-muted">Steps before it</p>
                <ol className="text-data flex flex-col gap-0.5 text-[12px] text-ink">
                  {steps.map((s, i) => (
                    <li key={i} className={String(s).includes("→ ERROR") ? "font-bold text-deal" : undefined}>
                      {String(s)}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </>
        );
      })()}
      {e.stack ? <StackViewer stack={e.stack} /> : null}
      <div>
        <CopyForAI text={eventReport(e)} />
      </div>
    </div>
  );
}

/** One event as a line; click it for `EventDetail`. */
export function EventRow({
  event,
}: Readonly<{
  event: ObsEventRowRead;
}>) {
  return (
    <li className="border-b border-line/60 last:border-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-baseline gap-2 px-3 py-2 hover:bg-[var(--line)]/20">
          <LevelTag level={event.level} />
          <Ago iso={event.occurredAt} className="w-[68px] shrink-0" />
          <span className="text-data shrink-0 text-[11.5px] text-muted">
            {event.source}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink group-open:whitespace-normal">
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
                errorTone(event.httpStatus >= 500, event.httpStatus >= 400)
              )}
            >
              {event.httpStatus}
            </span>
          ) : null}
        </summary>
        <div className="px-3 pb-3 pt-1">
          <EventDetail event={event} />
        </div>
      </details>
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
 * second. A missing source reports "not configured" rather than a green tick.
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
export function WindowNote({ days }: Readonly<{ days: number }>) {
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
  title,
}: Readonly<{
  rows: MetricTableRow[];
  keyHeader: string;
  hrefFor?: (key: string) => string;
  emptyNote: string;
  /** What the table is, for its "Copy for AI" report. Defaults to the key header. */
  title?: string;
}>) {
  if (!rows.length) {
    return <p className="py-3 text-[13px] text-muted">{emptyNote}</p>;
  }
  const nf = new Intl.NumberFormat("en-IN");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <CopyForAI text={metricsReport(title ?? `Calls by ${keyHeader.toLowerCase()}`, rows)} label="Copy table for AI" />
      </div>
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
                      errorTone(bad, warn)
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
    </div>
  );
}
