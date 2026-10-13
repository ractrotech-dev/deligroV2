import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { AdminHero, EmptyState, Panel } from "@/components/admin/admin-ui";
import { Ago, SeverityPill, StatusPill } from "@/components/developer/obs-ui";
import { listIncidents } from "@/lib/obs/read";
import { openIncident } from "../actions";

/**
 * Observability → Incidents.
 *
 * An issue is a bug; an incident is the work of handling one. They are separate
 * records because they have different lifetimes and different readers: issues
 * are deleted at 180 days, and incidents are **never** auto-deleted.
 *
 * That is the point of this screen. Retention exists so the raw stream does not
 * cost more than the platform, but an outage the team gets to have twice is
 * more expensive than any amount of storage — so the notes, the sequence of
 * decisions and the resolution stay for good.
 */
export const dynamic = "force-dynamic";

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const sp = await searchParams;
  const includeClosed = sp.all === "1";
  const incidents = await listIncidents(includeClosed);

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Incidents"
        subtitle="The record of what happened and what was decided. Never auto-deleted."
        tag={`${incidents.data.length} ${includeClosed ? "total" : "open"}`}
        action={
          <Link
            href={`/developer/observability/incidents${includeClosed ? "" : "?all=1"}`}
            className="press rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink"
          >
            {includeClosed ? "Open only" : "Include closed"}
          </Link>
        }
      />

      {/* A row of labelled inputs, capped at a reading measure like every other
          console form — the title field was taking a thousand pixels. */}
      <Panel className="admin-measure" title="Open an incident">
        <form action={openIncident} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <span className="text-[11.5px] font-semibold text-muted">
              What is happening
            </span>
            <input
              name="title"
              required
              placeholder="Payments not settling against orders"
              className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] font-semibold text-muted">Severity</span>
            <select
              name="severity"
              defaultValue="high"
              className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink"
            >
              {["critical", "high", "medium", "low"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="press h-9 rounded-lg bg-ink px-4 text-xs font-semibold text-[color:var(--surface)]"
          >
            Open
          </button>
        </form>
        <p className="mt-2 text-[11px] italic text-muted">
          Most incidents are better opened from the issue they came out of — that
          links the two and moves the issue to investigating in one step.
        </p>
      </Panel>

      <Panel>
        {incidents.data.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={includeClosed ? "No incidents recorded" : "No open incidents"}
            description={
              includeClosed
                ? "Nothing has been escalated yet. Incidents are opened by hand, from an issue or from the form above."
                : "Nothing is currently being worked. Include closed to see the history."
            }
          />
        ) : (
          <ul className="flex flex-col">
            {incidents.data.map((inc) => (
              <li key={inc.id}>
                <Link
                  href={`/developer/observability/incidents/${inc.shortId}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 py-2.5 last:border-0 hover:bg-[var(--line)]/20"
                >
                  <SeverityPill severity={inc.severity} />
                  <StatusPill status={inc.status} />
                  <span className="text-data shrink-0 text-[11px] text-muted">
                    {inc.shortId}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
                    {inc.title}
                  </span>
                  <Ago iso={inc.detectedAt} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
