import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHero, Panel } from "@/components/admin/admin-ui";
import {
  AttrGrid,
  EventRow,
  Figure,
  FigureStrip,
  SeverityPill,
  StackViewer,
  StatusPill,
  WindowNote,
  ms,
} from "@/components/admin/obs-ui";
import {
  getDeployCorrelation,
  getIssue,
  getIssueEvents,
  getIssueImpact,
} from "@/lib/obs/read";
import { getMetricRows } from "@/lib/obs/metrics";
import { CONFIDENCE_LABEL, diagnose } from "@/lib/obs/diagnose";
import { setIssueSeverity, setIssueStatus, openIncident } from "../../actions";
import type { ObsSeverity } from "@/lib/obs/types";
import { cn } from "@/lib/utils/cn";

/**
 * Observability → Issue detail. The investigation page.
 *
 * Ordered by the questions an operator asks, in the order they ask them:
 *
 *   1. What is it, and is it still happening?          (header, figures)
 *   2. Who did it reach?                               (impact)
 *   3. What do I think happened, and how sure is that? (diagnosis)
 *   4. What do I do first?                             (next steps)
 *   5. Show me the actual failure.                     (stack, request)
 *   6. Show me it happening.                           (timeline, traces)
 *   7. Record what I decided.                          (actions)
 *
 * Two numbers on this page mean different things and are labelled so: the
 * occurrence count is exact and permanent, and the affected-user and
 * affected-order counts can only be computed from raw events, which expire at
 * 14 days. A distinct count that silently shrinks when a partition is dropped
 * would be a number that lies about its own meaning.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

const SEVERITIES: ObsSeverity[] = ["critical", "high", "medium", "low", "info"];

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ shortId: string }>;
}) {
  const { shortId } = await params;
  const issue = (await getIssue(shortId)).data;
  if (!issue) notFound();

  const [impact, events, correlation, providerRows] = await Promise.all([
    getIssueImpact(issue.fingerprint),
    getIssueEvents(issue.fingerprint, 30),
    getDeployCorrelation(issue.firstSeen, issue.env),
    getMetricRows("provider", "1h", issue.env),
  ]);

  const sample = events.data[0] ?? null;
  const providerRate = sample?.provider
    ? (providerRows.rows.find((r) => r.key === sample.provider)?.errorRate ?? null)
    : null;

  const finding = diagnose({
    kind: issue.kind,
    source: sample?.source ?? issue.culprit ?? issue.kind,
    errorType: sample?.errorType ?? null,
    message: issue.title,
    provider: sample?.provider ?? null,
    httpRoute: sample?.httpRoute ?? null,
    httpStatus: sample?.httpStatus ?? null,
    severity: issue.severity,
    deployMinutesBefore: correlation.data?.minutesBefore ?? null,
    providerErrorRate: providerRate,
  });

  // Orders touched by this issue, for the order-context block. Taken from the
  // sampled events rather than counted separately: these are the ones an
  // operator can actually open and make right.
  const affectedOrders = [
    ...new Set(events.data.map((e) => e.orderId).filter(Boolean)),
  ].slice(0, 12) as string[];

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        backHref="/admin/observability/issues"
        backLabel="Issues"
        title={issue.title}
        subtitle={issue.culprit ?? undefined}
        tag={issue.shortId}
        badge={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityPill
              severity={issue.severity}
              manual={issue.severitySource === "manual"}
            />
            <StatusPill status={issue.status} />
            {issue.env !== "production" ? (
              <span className="text-data rounded border border-line px-1.5 py-0.5 text-[10.5px] uppercase text-muted">
                {issue.env}
              </span>
            ) : null}
          </span>
        }
      />

      {issue.status === "regressed" ? (
        <p className="rounded-xl border border-deal/40 bg-deal-soft px-3.5 py-2.5 text-[13px] font-medium text-ink">
          This issue was marked resolved and then happened again
          {issue.releaseLastSeen ? ` on ${issue.releaseLastSeen}` : ""}. Either the
          fix did not land, or it did not cover this path.
        </p>
      ) : null}

      {/* ---------- 1 & 2: scale and blast radius ---------- */}
      <FigureStrip>
        <Figure
          label="Occurrences"
          value={nf.format(issue.occurrences)}
          note="Exact — counted at ingest, never expires"
        />
        <Figure
          label="Users affected"
          value={nf.format(impact.data.affectedUsers)}
          note={`in the last ${impact.data.windowDays} days`}
          tone={impact.data.affectedUsers > 0 ? "warn" : undefined}
        />
        <Figure
          label="Orders affected"
          value={nf.format(impact.data.affectedOrders)}
          note={`in the last ${impact.data.windowDays} days`}
          tone={impact.data.affectedOrders > 0 ? "bad" : undefined}
        />
        <Figure label="First seen" value={shortTime(issue.firstSeen)} note={issue.releaseFirstSeen ?? "no release recorded"} />
        <Figure label="Last seen" value={shortTime(issue.lastSeen)} note={issue.releaseLastSeen ?? "no release recorded"} />
      </FigureStrip>
      <p className="-mt-2 px-1">
        <WindowNote days={impact.data.windowDays} />
      </p>

      <div className="flex flex-col gap-4 @4xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* ---------- 3: what happened ---------- */}
          <Panel
            title="Possible root cause"
            subtitle="Rule-based correlation. Nothing here is generated prose."
            action={<ConfidenceTag confidence={finding.confidence} />}
          >
            <p className="text-[14px] font-medium text-ink">{finding.statement}</p>
            {finding.attribution && finding.attribution !== "unknown" ? (
              <p className="mt-2 text-[12.5px] text-muted">
                Attribution:{" "}
                <strong className="text-ink">
                  {finding.attribution === "provider"
                    ? "an external provider"
                    : finding.attribution === "configuration"
                      ? "this deployment's configuration"
                      : "Deligro's own code"}
                </strong>
              </p>
            ) : null}
            {finding.evidence.length ? (
              <ul className="mt-3 flex flex-col gap-1.5">
                {finding.evidence.map((e, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] text-muted">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-current" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>

          {/* ---------- 4: what to do ---------- */}
          <Panel
            title="What to do first"
            subtitle="Guidance for this failure mode, not an automatic diagnosis."
          >
            <ol className="flex flex-col gap-2">
              {finding.nextSteps.map((step, i) => (
                <li key={i} className="flex gap-2.5 text-[13px] text-ink">
                  <span className="text-data mt-[1px] size-[18px] shrink-0 rounded bg-[var(--line)]/60 text-center text-[11px] font-bold leading-[18px] text-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
          </Panel>

          {/* ---------- 5: the failure itself ---------- */}
          {sample?.stack ? (
            <Panel
              title="Stack trace"
              subtitle="Most recent occurrence. Frames inside src/ are emphasised; dependency frames are dimmed, not hidden."
            >
              <StackViewer stack={sample.stack} />
            </Panel>
          ) : null}

          {sample ? (
            <Panel
              title="Request"
              subtitle="Safe metadata only — no bodies, no headers beyond a four-key allowlist, no IP addresses."
            >
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[12.5px]">
                <Row label="When" value={new Date(sample.occurredAt).toLocaleString("en-IN")} />
                {sample.httpMethod ? <Row label="Method" value={sample.httpMethod} /> : null}
                {sample.httpRoute ? <Row label="Endpoint" value={sample.httpRoute} mono /> : null}
                {sample.httpStatus ? <Row label="Status" value={String(sample.httpStatus)} /> : null}
                {sample.durationMs !== null ? <Row label="Duration" value={ms(sample.durationMs)} /> : null}
                {sample.errorType ? <Row label="Error type" value={sample.errorType} mono /> : null}
                {sample.provider ? <Row label="Provider" value={sample.provider} /> : null}
                {sample.release ? <Row label="Release" value={sample.release} mono /> : null}
                {sample.requestId ? <Row label="Request id" value={sample.requestId} mono /> : null}
                {sample.traceId ? (
                  <div className="contents">
                    <dt className="text-muted">Trace id</dt>
                    <dd className="min-w-0">
                      <Link
                        href={`/admin/observability/traces/${sample.traceId}`}
                        className="text-data break-all underline underline-offset-2"
                      >
                        {sample.traceId}
                      </Link>
                    </dd>
                  </div>
                ) : null}
                {sample.actorRole ? <Row label="Actor role" value={sample.actorRole} /> : null}
                {sample.actorId ? (
                  <div className="contents">
                    <dt className="text-muted">Actor</dt>
                    <dd className="min-w-0">
                      <Link
                        href={`/admin/customers/${sample.actorId}`}
                        className="text-data break-all underline underline-offset-2"
                      >
                        {sample.actorId.slice(0, 8).toUpperCase()}
                      </Link>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {Object.keys(sample.attrs).length ? (
                <div className="mt-3 border-t border-line pt-3">
                  <AttrGrid attrs={sample.attrs} />
                </div>
              ) : null}
              <p className="mt-3 text-[11px] italic text-muted">
                Identity is a profile id and nothing else. Names, phone numbers and
                emails are never stored here — open the customer page for those,
                where access is already audited.
              </p>
            </Panel>
          ) : null}

          {/* ---------- 6: it happening ---------- */}
          <Panel
            title="Recent occurrences"
            subtitle={`Latest ${events.data.length} of ${nf.format(issue.occurrences)}. Older ones have expired from raw storage.`}
          >
            {events.data.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">
                No raw events survive for this issue — they are kept 14 days. The
                occurrence count above is still exact.
              </p>
            ) : (
              <ul className="-mx-3">
                {events.data.map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* ---------- side column ---------- */}
        <div className="flex w-full min-w-0 flex-col gap-4 @4xl:w-[320px] @4xl:shrink-0">
          {correlation.data ? (
            <Panel title="Deployment nearby">
              <p className="text-[13px] text-ink">
                <strong className="text-data">{correlation.data.deploy.release}</strong>{" "}
                deployed{" "}
                <strong>{correlation.data.minutesBefore} min</strong> before this
                issue was first seen.
              </p>
              {correlation.data.deploy.commitMessage ? (
                <p className="mt-1.5 text-[12px] text-muted">
                  {correlation.data.deploy.commitMessage}
                </p>
              ) : null}
              <p className="mt-2.5 text-[11px] italic text-muted">
                Adjacency, not attribution. Most deploys are innocent; the way to
                tell is whether the changed code touches this path.
              </p>
            </Panel>
          ) : null}

          {affectedOrders.length ? (
            <Panel
              title="Orders touched"
              subtitle="From the sampled events — the ones you can open and make right."
            >
              <ul className="flex flex-wrap gap-1.5">
                {affectedOrders.map((id) => (
                  <li key={id}>
                    <Link
                      href={`/admin/orders/${id}`}
                      className="text-data inline-block rounded border border-line px-1.5 py-0.5 text-[11px] text-ink hover:border-ink/30"
                    >
                      {id.slice(0, 8).toUpperCase()}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {/* ---------- 7: record the decision ---------- */}
          <Panel title="Triage">
            <form action={setIssueStatus} className="flex flex-col gap-2">
              <input type="hidden" name="shortId" value={issue.shortId} />
              <label className="text-[11.5px] font-semibold text-muted" htmlFor="status">
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={issue.status}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink"
              >
                {["open", "investigating", "resolved", "ignored"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                name="note"
                placeholder="Resolution note (kept when resolving)"
                defaultValue={issue.resolutionNote ?? ""}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted"
              />
              <button
                type="submit"
                className="press h-9 rounded-lg bg-ink text-xs font-semibold text-[color:var(--surface)]"
              >
                Save status
              </button>
            </form>

            <form action={setIssueSeverity} className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              <input type="hidden" name="shortId" value={issue.shortId} />
              <label className="text-[11.5px] font-semibold text-muted" htmlFor="severity">
                Severity
              </label>
              <select
                id="severity"
                name="severity"
                defaultValue={issue.severity}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink"
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="press h-9 rounded-lg border border-line text-xs font-semibold text-ink"
              >
                Set severity
              </button>
              <p className="text-[11px] italic text-muted">
                Setting this by hand takes the issue out of the auto-classifier
                permanently — your judgement is never overwritten.
              </p>
            </form>
          </Panel>

          {issue.incidentId ? (
            <Panel title="Incident">
              <p className="text-[13px] text-muted">
                This issue is linked to an open incident.
              </p>
              <Link
                href="/admin/observability/incidents"
                className="mt-2 inline-block text-[13px] font-semibold underline underline-offset-2"
              >
                Open incidents
              </Link>
            </Panel>
          ) : (
            <Panel title="Escalate">
              <form action={openIncident} className="flex flex-col gap-2">
                <input type="hidden" name="fromIssue" value={issue.shortId} />
                <input type="hidden" name="severity" value={issue.severity} />
                <input
                  name="title"
                  defaultValue={issue.title.slice(0, 120)}
                  className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink"
                />
                <button
                  type="submit"
                  className="press h-9 rounded-lg border border-line text-xs font-semibold text-ink"
                >
                  Open an incident
                </button>
                <p className="text-[11px] italic text-muted">
                  Incidents are never auto-deleted. Issues are, at 180 days — so
                  this is also how you keep the record.
                </p>
              </form>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className={cn("min-w-0 break-all text-ink", mono && "text-data")}>
        {value}
      </dd>
    </div>
  );
}

function ConfidenceTag({ confidence }: { confidence: keyof typeof CONFIDENCE_LABEL }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em]",
        confidence === "confirmed"
          ? "border-green/30 bg-green-soft text-green"
          : confidence === "likely"
            ? "border-pop/30 bg-[var(--c-tint-amber)] text-[color:var(--c-ink-amber)]"
            : confidence === "possible"
              ? "border-blue/25 bg-[var(--c-tint-blue)] text-blue"
              : "border-line bg-[var(--line)]/40 text-muted"
      )}
    >
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
}
