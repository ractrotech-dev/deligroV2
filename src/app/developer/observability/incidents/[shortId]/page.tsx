import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { Ago, SeverityPill, StatusPill } from "@/components/developer/obs-ui";
import { getIncident } from "@/lib/obs/read";
import { addIncidentNote, setIncidentStatus } from "../../actions";

/**
 * Observability → one incident.
 *
 * The stages run detected → investigating → identified → mitigating → resolved
 * → closed, and each stamps its own timestamp the FIRST time it is entered.
 * Re-entering a stage — an incident that reopens — does not rewrite when it was
 * first identified, the same rule the order lifecycle trigger follows in
 * migration 0026, and for the same reason: a history that can be rewritten is
 * not a history.
 *
 * Notes are append-only and never editable. This page is written to be read
 * months later by somebody who was not in the room, and an editable timeline is
 * not evidence.
 */
export const dynamic = "force-dynamic";

const STAGES = [
  "detected",
  "investigating",
  "identified",
  "mitigating",
  "resolved",
  "closed",
] as const;

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ shortId: string }>;
}) {
  const { shortId } = await params;
  const { data } = await getIncident(shortId);
  if (!data.incident) notFound();

  const inc = data.incident;
  const stageIndex = STAGES.indexOf(inc.status as (typeof STAGES)[number]);

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        backHref="/developer/observability/incidents"
        backLabel="Incidents"
        title={inc.title}
        tag={inc.shortId}
        badge={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityPill severity={inc.severity} />
            <StatusPill status={inc.status} />
          </span>
        }
        subtitle={inc.summary ?? undefined}
      />

      {/* ---------- stage strip ---------- */}
      <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border border-line bg-[var(--line)]">
        {STAGES.map((stage, i) => {
          const done = stageIndex >= i;
          return (
            <div
              key={stage}
              className="min-w-0 flex-1 basis-28 bg-surface px-3 py-2.5"
            >
              <p
                className={
                  done
                    ? "text-[12px] font-semibold capitalize text-ink"
                    : "text-[12px] capitalize text-muted"
                }
              >
                {stage}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {stage === "detected" ? (
                  <Ago iso={inc.detectedAt} />
                ) : stage === "resolved" && inc.resolvedAt ? (
                  <Ago iso={inc.resolvedAt} />
                ) : stage === "closed" && inc.closedAt ? (
                  <Ago iso={inc.closedAt} />
                ) : done ? (
                  "reached"
                ) : (
                  "—"
                )}
              </p>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-4 @4xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Panel
            title="Timeline"
            subtitle="Append-only. Status changes are recorded here too, so the timeline explains itself."
          >
            {data.notes.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">Nothing recorded yet.</p>
            ) : (
              <ol className="flex flex-col">
                {data.notes.map((note) => (
                  <li
                    key={note.id}
                    className="flex gap-3 border-b border-line/60 py-2.5 last:border-0"
                  >
                    <span className="w-[74px] shrink-0">
                      <Ago iso={note.createdAt} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={
                          note.kind === "note"
                            ? "block whitespace-pre-wrap text-[13px] text-ink"
                            : "block text-[13px] italic text-muted"
                        }
                      >
                        {note.body}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}

            <form
              action={addIncidentNote}
              className="mt-3 flex flex-col gap-2 border-t border-line pt-3"
            >
              <input type="hidden" name="shortId" value={inc.shortId} />
              <textarea
                name="body"
                required
                rows={3}
                placeholder="What did you find, what did you change, what did you rule out?"
                className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-muted"
              />
              <button
                type="submit"
                className="press h-9 self-start rounded-lg bg-ink px-4 text-xs font-semibold text-[color:var(--surface)]"
              >
                Add note
              </button>
            </form>
          </Panel>

          {data.issues.length ? (
            <Panel title="Linked issues">
              <ul className="flex flex-col">
                {data.issues.map((issue) => (
                  <li key={issue.fingerprint}>
                    <Link
                      href={`/developer/observability/issues/${issue.shortId}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 py-2 last:border-0 hover:bg-[var(--line)]/20"
                    >
                      <SeverityPill severity={issue.severity} />
                      <span className="text-data shrink-0 text-[11px] text-muted">
                        {issue.shortId}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {issue.title}
                      </span>
                      <span className="text-data shrink-0 text-[11.5px] tabular-nums text-muted">
                        ×{issue.occurrences}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] italic text-muted">
                Linked issues are exempt from the 180-day issue retention — an
                incident whose issues have evaporated explains nothing.
              </p>
            </Panel>
          ) : null}
        </div>

        <div className="flex w-full min-w-0 flex-col gap-4 @4xl:w-[300px] @4xl:shrink-0">
          <Panel title="Move it on">
            <form action={setIncidentStatus} className="flex flex-col gap-2">
              <input type="hidden" name="shortId" value={inc.shortId} />
              <select
                name="status"
                defaultValue={inc.status}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="press h-9 rounded-lg bg-ink text-xs font-semibold text-[color:var(--surface)]"
              >
                Update status
              </button>
              <p className="text-[11px] italic text-muted">
                Each stage stamps its time the first time it is entered. Going back
                does not rewrite it.
              </p>
            </form>
          </Panel>
        </div>
      </div>
    </div>
  );
}
