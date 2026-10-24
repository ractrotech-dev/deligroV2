import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { AdminHero, EmptyState, Panel } from "@/components/admin/admin-ui";
import { FilterChips, SearchForm } from "@/components/admin/admin-filters";
import {
  Ago,
  NotMigratedNotice,
  SeverityPill,
  StatusPill,
} from "@/components/developer/obs-ui";
import {
  listIssues,
  OBS_RANGES,
  type IssueFilters,
  type ObsRange,
} from "@/lib/obs/read";
import type { ObsEnv, ObsIssueStatus, ObsSeverity } from "@/lib/obs/types";
import { CopyForAI } from "@/components/developer/copy-for-ai";
import { issuesReport } from "@/lib/developer/ai-report";

/**
 * Observability → Issues. The work queue.
 *
 * A queue, not an archive: `resolved` and `ignored` are excluded unless asked
 * for, because a list that includes finished work stops being something anyone
 * can clear. Ordered by last seen rather than by severity — during an incident
 * the question is "what is happening now", and a two-week-old critical at the
 * top of the list buries the medium that started four minutes ago.
 *
 * All filter state lives in the URL. The page is a server component and
 * re-queries on every change, so the URL is the only place the choice can
 * honestly live — and it means an operator can paste a filtered view into a
 * message and the person who opens it sees the same thing.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

const SEVERITIES: ObsSeverity[] = ["critical", "high", "medium", "low"];
const STATUSES: ObsIssueStatus[] = [
  "open",
  "investigating",
  "regressed",
  "resolved",
  "ignored",
];
const ENVS: ObsEnv[] = ["production", "preview", "development"];

interface Query {
  severity?: string;
  status?: string;
  env?: string;
  range?: string;
  q?: string;
}

function href(current: Query, patch: Query): string {
  const merged: Query = { ...current, ...patch };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  const search = qs ? `?${qs}` : "";
  return `/developer/observability/issues${search}`;
}

export default async function IssuesPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Query>;
}>) {
  const sp = await searchParams;

  const severity = SEVERITIES.includes(sp.severity as ObsSeverity)
    ? (sp.severity as ObsSeverity)
    : null;
  const status = STATUSES.includes(sp.status as ObsIssueStatus)
    ? (sp.status as ObsIssueStatus)
    : null;
  // Production by default, and a banner whenever it is not — the two must never
  // be read for each other, which is why `env` is part of the fingerprint too.
  const env = ENVS.includes(sp.env as ObsEnv) ? (sp.env as ObsEnv) : "production";
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "7d";

  const filters: IssueFilters = {
    env,
    severity: severity ?? "all",
    status: status ?? undefined,
    range,
    q: sp.q,
    limit: 150,
  };

  const issues = await listIssues(filters);

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Issues"
        subtitle="One row is one bug, however many times it happened. Grouped by fingerprint at ingest."
        tag={
          issues.notMigrated
            ? "Not installed"
            : `${nf.format(issues.data.length)} shown`
        }
      />

      {issues.notMigrated ? <NotMigratedNotice /> : null}

      {env !== "production" ? (
        <p className="rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-2.5 text-[13px] font-medium text-ink">
          Showing <strong>{env}</strong> telemetry. These are not production
          problems — development and preview keep their own issues, because the
          environment is part of the grouping key.
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <SearchForm
          action="/developer/observability/issues"
          defaultValue={sp.q}
          placeholder="Search issue titles and culprits"
          carry={{ severity: sp.severity, status: sp.status, env: sp.env, range: sp.range }}
        />
        <div className="flex flex-col gap-2">
          <FilterChips
            label="Severity"
            options={SEVERITIES.map((s) => ({ value: s, label: s }))}
            active={severity}
            hrefFor={(v) => href(sp, { severity: v ?? undefined })}
          />
          <FilterChips
            label="Status"
            options={STATUSES.map((s) => ({ value: s, label: s }))}
            active={status}
            hrefFor={(v) => href(sp, { status: v ?? undefined })}
          />
          <div className="flex flex-wrap gap-4">
            <FilterChips
              label="Window"
              options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
              active={range}
              hrefFor={(v) => href(sp, { range: v ?? undefined })}
            />
            <FilterChips
              label="Environment"
              options={ENVS.map((e) => ({ value: e, label: e }))}
              active={env}
              hrefFor={(v) => href(sp, { env: v ?? undefined })}
            />
          </div>
        </div>
      </div>

      <Panel action={<CopyForAI text={issuesReport(issues.data)} label="Copy all issues for AI" />}>
        {issues.data.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="Nothing matching"
            description={
              issues.notMigrated
                ? "Observability is not installed on this database, so there is nothing to list."
                : "No issues match these filters. An empty queue with no filters set is genuinely good news — widen the window to check."
            }
          />
        ) : (
          <ul className="flex flex-col">
            {issues.data.map((issue) => (
              <li key={issue.fingerprint}>
                <Link
                  href={`/developer/observability/issues/${issue.shortId}`}
                  className="flex flex-col gap-1 border-b border-line/60 py-2.5 last:border-0 hover:bg-[var(--line)]/20"
                >
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <SeverityPill
                      severity={issue.severity}
                      manual={issue.severitySource === "manual"}
                    />
                    {issue.status !== "open" ? (
                      <StatusPill status={issue.status} />
                    ) : null}
                    <span className="text-data shrink-0 text-[11px] text-muted">
                      {issue.shortId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
                      {issue.title}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pl-1">
                    {issue.culprit ? (
                      <span className="text-data min-w-0 truncate text-[11.5px] text-muted">
                        {issue.culprit}
                      </span>
                    ) : null}
                    <span className="text-data shrink-0 text-[11.5px] tabular-nums text-muted">
                      ×{nf.format(issue.occurrences)}
                    </span>
                    {issue.usersAffected ? (
                      <span className="text-data shrink-0 text-[11.5px] tabular-nums text-muted">
                        {nf.format(issue.usersAffected)} {issue.usersAffected === 1 ? "person" : "people"}
                      </span>
                    ) : null}
                    {issue.releaseLastSeen ? (
                      <span className="text-data shrink-0 text-[11.5px] text-muted">
                        {issue.releaseLastSeen}
                      </span>
                    ) : null}
                    <span className="shrink-0">
                      <Ago iso={issue.lastSeen} />
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
