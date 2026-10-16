import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { AdminHero, EmptyState, Panel, RangeTabs } from "@/components/admin/admin-ui";
import {
  Ago,
  Figure,
  FigureStrip,
  HealthLine,
  NotMigratedNotice,
  SeverityPill,
  StatusPill,
} from "@/components/developer/obs-ui";
import {
  getErrorSummary,
  getSystemHealth,
  type ErrorSummary,
  type HealthState,
} from "@/lib/obs/metrics";
import {
  listAlertFirings,
  listDeploys,
  listIncidents,
  listIssues,
  OBS_RANGES,
  type ObsRange,
} from "@/lib/obs/read";

/**
 * Observability → Overview.
 *
 * The screen an operator opens when something feels wrong, ordered by the
 * sequence they actually work in: is anything broken right now (health), how
 * much is broken (errors), what specifically (issues), and what has already
 * been decided about it (incidents and alerts).
 *
 * Every number is counted. Nothing on this page is seeded, sampled up or
 * rounded to look busy — the same commitment `admin-stats.ts` made after the
 * dashboard was found rendering invented figures, and the reason
 * `unavailable` is a distinct state from zero throughout. A dashboard that
 * shows a confident zero during an outage of its own pipeline is worse than a
 * blank page.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

const RANGE_VALUES: ObsRange[] = OBS_RANGES.map((r) => r.value);

/** Reuses the numeric RangeTabs by index — the labels are what the operator reads. */
const RANGE_OPTIONS = OBS_RANGES.map((r, i) => ({ value: i, label: r.label }));

/** The note under "Errors in window": the change against the previous window. */
function errorsChangeNote(errors: ErrorSummary, rangeIndex: number): string {
  if (errors.unavailable) return "Pipeline unavailable";
  if (errors.changePct === null) return "No comparable previous window";
  const arrow = errors.changePct >= 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(errors.changePct)}% vs the previous ${OBS_RANGES[rangeIndex]?.label.toLowerCase()}`;
}

export default async function ObservabilityOverview({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ range?: string }>;
}>) {
  const sp = await searchParams;
  const rangeIndex = Math.max(
    0,
    RANGE_VALUES.indexOf((sp.range as ObsRange) ?? "24h")
  );
  const range = RANGE_VALUES[rangeIndex] ?? "24h";

  const [health, errors, issues, incidents, firings, deploys] = await Promise.all([
    getSystemHealth(),
    getErrorSummary(range),
    listIssues({ range, limit: 8 }),
    listIncidents(),
    listAlertFirings(true, 5),
    listDeploys("production", 3),
  ]);

  const notMigrated = issues.notMigrated || errors.unavailable;

  const errorsNote = errorsChangeNote(errors, rangeIndex);

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Observability"
        subtitle="What is broken, who it reached, and what has already been decided about it."
        tag={overallLabel(health.overall)}
        action={
          <RangeTabs
            options={RANGE_OPTIONS}
            active={rangeIndex}
            hrefFor={(i) => `/developer/observability?range=${RANGE_VALUES[i]}`}
          />
        }
      />

      {notMigrated ? <NotMigratedNotice /> : null}

      {/* ---------- errors ---------- */}
      <FigureStrip>
        <Figure
          label="Errors in window"
          value={errors.unavailable ? "—" : nf.format(errors.total)}
          note={errorsNote}
          tone={errors.total > 0 ? "warn" : undefined}
        />
        <Figure
          label="Critical issues"
          value={errors.unavailable ? "—" : nf.format(errors.critical)}
          note="Money or access already broken"
          tone={errors.critical > 0 ? "bad" : "good"}
        />
        <Figure
          label="Unresolved issues"
          value={errors.unavailable ? "—" : nf.format(errors.unresolvedIssues)}
          note="Open, investigating or regressed"
        />
        <Figure
          label="New in window"
          value={errors.unavailable ? "—" : nf.format(errors.newIssues)}
          note="First seen inside this window"
        />
        <Figure
          label="Regressed"
          value={errors.unavailable ? "—" : nf.format(errors.regressedIssues)}
          note="Resolved, then came back"
          tone={errors.regressedIssues > 0 ? "bad" : undefined}
        />
      </FigureStrip>

      <div className="flex flex-col gap-4 @3xl:flex-row">
        {/* ---------- health ---------- */}
        <Panel
          className="min-w-0 flex-1"
          title="System health"
          subtitle="Configuration facts and observed behaviour, told apart."
        >
          <ul className="-mt-1">
            {health.rows.map((row) => (
              <HealthLine key={row.label} {...row} />
            ))}
          </ul>
          <p className="mt-3 text-[11px] italic text-muted">
            Nothing here calls a provider to check. A synthetic probe would spend
            money at Razorpay, send a real SMS, or push to a real handset on every
            page load — so a configured-but-quiet integration reads as{" "}
            <em>unknown</em>, never as healthy.
          </p>
        </Panel>

        {/* ---------- what has been decided ---------- */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Panel
            title="Firing now"
            subtitle="Alert rules currently above their threshold."
            action={
              <Link
                href="/developer/observability/alerts"
                className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink"
              >
                Rules
              </Link>
            }
          >
            {firings.data.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">
                Nothing is firing. Note that rules ship <strong>disabled</strong>{" "}
                — check the Alerts tab before reading this as all-clear.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {firings.data.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-line bg-surface px-3 py-2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-semibold text-ink">
                        {f.ruleName}
                      </span>
                      <Ago iso={f.firedAt} />
                    </div>
                    <p className="mt-0.5 text-[12px] text-muted">{f.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Open incidents"
            action={
              <Link
                href="/developer/observability/incidents"
                className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink"
              >
                All
              </Link>
            }
          >
            {incidents.data.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">No open incidents.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {incidents.data.slice(0, 4).map((inc) => (
                  <li key={inc.id}>
                    <Link
                      href={`/developer/observability/incidents/${inc.shortId}`}
                      className="block rounded-lg border border-line bg-surface px-3 py-2 hover:border-ink/25"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-data text-[11px] text-muted">
                          {inc.shortId}
                        </span>
                        <SeverityPill severity={inc.severity} />
                        <StatusPill status={inc.status} />
                      </div>
                      <p className="mt-1 text-[13px] font-semibold text-ink">
                        {inc.title}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/* ---------- issues ---------- */}
      <Panel
        title="Most recent issues"
        subtitle="Grouped by fingerprint — one row is one bug, however many times it happened."
        action={
          <Link
            href="/developer/observability/issues"
            className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink"
          >
            All issues
          </Link>
        }
      >
        {issues.data.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No unresolved issues in this window"
            description={
              notMigrated
                ? "Observability is not installed, so there is nothing to show — this is not the same as nothing being wrong."
                : "Nothing has been recorded above a warning. Widen the window if you are looking for something older."
            }
          />
        ) : (
          <ul className="flex flex-col">
            {issues.data.map((issue) => (
              <li key={issue.fingerprint}>
                <Link
                  href={`/developer/observability/issues/${issue.shortId}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 py-2.5 last:border-0 hover:bg-[var(--line)]/20"
                >
                  <SeverityPill
                    severity={issue.severity}
                    manual={issue.severitySource === "manual"}
                  />
                  <span className="text-data shrink-0 text-[11px] text-muted">
                    {issue.shortId}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                    {issue.title}
                  </span>
                  {issue.status === "regressed" ? (
                    <StatusPill status="regressed" />
                  ) : null}
                  <span className="text-data shrink-0 text-[11.5px] tabular-nums text-muted">
                    ×{nf.format(issue.occurrences)}
                  </span>
                  <Ago iso={issue.lastSeen} className="w-[64px] text-right" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ---------- deploys ---------- */}
      <Panel
        title="Recent releases"
        subtitle="Shown beside issue timelines as adjacency. A deploy near an onset is a lead, not a cause."
      >
        {deploys.data.length === 0 ? (
          <p className="py-2 text-[13px] text-muted">
            No releases recorded. Markers are written at boot from{" "}
            <code className="text-data">VERCEL_GIT_COMMIT_SHA</code>, so a local or
            self-hosted build produces none.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {deploys.data.map((d) => (
              <li
                key={d.release}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
              >
                <span className="text-data text-[12px] font-semibold text-ink">
                  {d.release}
                </span>
                <Ago iso={d.deployedAt} />
                {d.branch ? (
                  <span className="text-data text-[11px] text-muted">{d.branch}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  {d.commitMessage ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function overallLabel(state: HealthState): string {
  switch (state) {
    case "ok":
      return "All systems operational";
    case "degraded":
      return "Degraded";
    case "down":
      return "Outage";
    case "off":
      return "Partly unconfigured";
    default:
      // Never "operational". A probe that could not answer must not be
      // presented as one that answered yes.
      return "Status unknown";
  }
}
