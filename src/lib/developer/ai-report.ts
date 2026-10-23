import type { HealthState } from "@/lib/obs/metrics";
import type { ObsEventRowRead, ObsIssueRow } from "@/lib/obs/read";
import type { Diagnosis } from "@/lib/obs/diagnose";

/**
 * Plain-text reports of what the Developer panel shows, written to be pasted
 * into an AI assistant (or a ticket) as-is: what was seen, every field the
 * panel has for it, where in the codebase it comes from, and the ask.
 *
 * Pure formatting — nothing here reads data. Each page passes what it already
 * rendered, so a copied report never says more than the screen did.
 */

const HEALTH_WORD: Record<HealthState, string> = {
  ok: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
  off: "Not configured",
};

const PREAMBLE =
  "Project: Deligro (Next.js App Router + Supabase), repository whiteslam/deligro26. " +
  "This was copied from the app's Developer panel.";

const ASK_FIX =
  "Find the root cause in the codebase and fix it. If it is configuration rather than code " +
  "(an env var, a Supabase setting, a cron job, a provider), say exactly what to change and where.";

const ASK_REVIEW =
  "Review these. For each one that is a real problem, find the root cause in the codebase and fix it; " +
  "say which are expected (e.g. a feature deliberately switched off) and need no change.";

export interface HealthRowLike {
  label: string;
  state: HealthState;
  detail: string;
  note?: string;
}

/** Healthy and switched-off rows are not problems; everything else is. */
export function isHealthProblem(state: HealthState): boolean {
  return state === "degraded" || state === "down" || state === "unknown";
}

function healthLines(row: HealthRowLike): string[] {
  const out = [`- ${row.label}: ${HEALTH_WORD[row.state]}`, `  Detail: ${row.detail}`];
  if (row.note) out.push(`  Note: ${row.note}`);
  return out;
}

/** One health check, with the ask. */
export function healthCheckReport(
  row: HealthRowLike,
  ctx: { group?: string; source?: string } = {}
): string {
  return [
    PREAMBLE,
    "",
    `A health check${ctx.group ? ` in "${ctx.group}"` : ""} reports ${HEALTH_WORD[row.state].toUpperCase()}.`,
    "",
    ...healthLines(row),
    ...(ctx.source ? ["", `The check is computed in ${ctx.source}.`] : []),
    "",
    row.state === "ok" ? "This check passes; explain what it verifies." : ASK_FIX,
  ].join("\n");
}

/**
 * A whole group of checks. `problemsOnly` keeps degraded / down / unknown rows
 * (the "copy everything that needs attention" button); null when that leaves
 * nothing to copy.
 */
export function healthGroupReport(
  groups: readonly { title: string; rows: readonly HealthRowLike[] }[],
  opts: { problemsOnly?: boolean; source?: string } = {}
): string | null {
  const sections: string[] = [];
  let count = 0;
  for (const g of groups) {
    const rows = opts.problemsOnly ? g.rows.filter((r) => isHealthProblem(r.state)) : g.rows;
    if (!rows.length) continue;
    count += rows.length;
    sections.push(`## ${g.title}`, ...rows.flatMap(healthLines), "");
  }
  if (!count) return null;
  return [
    PREAMBLE,
    "",
    opts.problemsOnly
      ? `${count} health check${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention:`
      : `Health checks (${count}):`,
    "",
    ...sections,
    ...(opts.source ? [`The checks are computed in ${opts.source}.`, ""] : []),
    ASK_REVIEW,
  ].join("\n");
}

/** Every field an event carries, one per line, empty ones left out. */
function eventLines(e: ObsEventRowRead): string[] {
  const fields: [string, string | number | null][] = [
    ["Time", e.occurredAt],
    ["Level", e.level],
    ["Kind", e.kind],
    ["Source", e.source],
    ["Message", e.message],
    ["Environment", e.env],
    ["Release", e.release],
    ["Endpoint", e.httpRoute ? `${e.httpMethod ?? ""} ${e.httpRoute}`.trim() : null],
    ["HTTP status", e.httpStatus],
    ["Duration", e.durationMs !== null ? `${Math.round(e.durationMs)}ms` : null],
    ["Provider", e.provider],
    ["Error type", e.errorType],
    ["Fingerprint", e.errorFingerprint],
    ["Trace", e.traceId],
    ["Request", e.requestId],
    ["Actor", e.actorRole ? `${e.actorRole}${e.actorId ? ` ${e.actorId}` : ""}` : null],
    ["Order", e.orderId],
    ["Restaurant", e.restaurantId],
    ["Rider", e.driverId],
  ];
  const out = fields.filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}: ${v}`);
  if (Object.keys(e.attrs).length) out.push(`Attributes: ${JSON.stringify(e.attrs)}`);
  if (e.stack) out.push("Stack:", e.stack);
  return out;
}

export function eventReport(e: ObsEventRowRead): string {
  return [PREAMBLE, "", "One logged event:", "", ...eventLines(e), "", e.level === "error" || e.level === "fatal" ? ASK_FIX : "Explain what this event means and whether anything needs fixing."].join("\n");
}

export function eventsReport(events: readonly ObsEventRowRead[], title: string): string | null {
  if (!events.length) return null;
  return [
    PREAMBLE,
    "",
    `${title} (${events.length} events, newest first):`,
    "",
    ...events.flatMap((e, i) => [`### ${i + 1}`, ...eventLines(e), ""]),
    ASK_REVIEW,
  ].join("\n");
}

function issueLines(i: ObsIssueRow): string[] {
  return [
    `${i.shortId} — ${i.title}`,
    `  Severity: ${i.severity}${i.severitySource === "manual" ? " (set by hand)" : ""} · Status: ${i.status} · Kind: ${i.kind} · Env: ${i.env}`,
    ...(i.culprit ? [`  Culprit: ${i.culprit}`] : []),
    `  Occurrences: ${i.occurrences} · First seen: ${i.firstSeen}${i.releaseFirstSeen ? ` (${i.releaseFirstSeen})` : ""} · Last seen: ${i.lastSeen}${i.releaseLastSeen ? ` (${i.releaseLastSeen})` : ""}`,
    ...(i.resolutionNote ? [`  Resolution note: ${i.resolutionNote}`] : []),
  ];
}

export function issuesReport(issues: readonly ObsIssueRow[]): string | null {
  if (!issues.length) return null;
  return [
    PREAMBLE,
    "",
    `${issues.length} issue${issues.length === 1 ? "" : "s"} (one row per distinct bug, grouped by fingerprint):`,
    "",
    ...issues.flatMap((i) => [...issueLines(i), ""]),
    "Open the culprit for each, find the root cause and fix it, most severe first. " +
      "Say which ones you could not reproduce from the code alone and what extra detail would help.",
  ].join("\n");
}

/** The issue page's whole investigation: the issue, the diagnosis, the latest occurrences. */
export function issueReport(
  issue: ObsIssueRow,
  finding: Diagnosis,
  events: readonly ObsEventRowRead[]
): string {
  const latest = events.slice(0, 5);
  return [
    PREAMBLE,
    "",
    "Bug report:",
    "",
    ...issueLines(issue),
    "",
    `Panel's diagnosis (${finding.confidence} confidence): ${finding.statement}`,
    ...finding.evidence.map((x) => `- ${x}`),
    ...(finding.nextSteps.length ? ["Suggested first steps:", ...finding.nextSteps.map((x, n) => `${n + 1}. ${x}`)] : []),
    "",
    ...(latest.length
      ? [`Latest ${latest.length} occurrence${latest.length === 1 ? "" : "s"}:`, "", ...latest.flatMap((e, n) => [`### ${n + 1}`, ...eventLines(e), ""])]
      : ["No raw events survive for this issue (kept 14 days).", ""]),
    ASK_FIX,
  ].join("\n");
}

export interface MetricRowLike {
  key: string;
  count: number;
  errorCount: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

const msText = (v: number | null) => (v === null ? "—" : `${Math.round(v)}ms`);

export function metricsReport(title: string, rows: readonly MetricRowLike[]): string | null {
  if (!rows.length) return null;
  return [
    PREAMBLE,
    "",
    `${title}:`,
    "",
    "key | calls | errors | error rate | p50 | p95 | p99",
    ...rows.map((r) =>
      [r.key, r.count, r.errorCount, `${r.errorRate.toFixed(1)}%`, msText(r.p50), msText(r.p95), msText(r.p99)].join(" | ")
    ),
    "",
    "Point out the rows with a high error rate or slow p95/p99 (ignore tiny call counts), find why in the codebase, and fix them.",
  ].join("\n");
}

export interface FiringLike {
  ruleName: string;
  message: string;
  observed: number | string;
  threshold: number | string;
  sampleCount: number;
  firedAt: string;
  resolvedAt?: string | null;
}

export function firingsReport(firings: readonly FiringLike[], title: string): string | null {
  if (!firings.length) return null;
  return [
    PREAMBLE,
    "",
    `${title} (${firings.length}):`,
    "",
    ...firings.flatMap((f) => [
      `- ${f.ruleName}: ${f.message}`,
      `  Observed ${f.observed} against a threshold of ${f.threshold}, over ${f.sampleCount} samples. Fired ${f.firedAt}${f.resolvedAt ? `, resolved ${f.resolvedAt}` : ", still firing"}.`,
    ]),
    "",
    ASK_REVIEW,
  ].join("\n");
}
