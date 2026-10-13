import Link from "next/link";
import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { Figure, FigureStrip, HealthLine } from "@/components/developer/obs-ui";
import { getScorecard } from "@/lib/developer/scorecard.server";

export const dynamic = "force-dynamic";

/**
 * The Developer panel's front page: a scorecard of individual checks, each with
 * what it measured and when. There is deliberately no single green "Healthy":
 * a check that cannot be answered says Unknown, and an integration nobody
 * configured says Not configured, so a quiet board never reads as a good one.
 */
export default async function DeveloperOverview() {
  const { groups, summary, checkedAt } = await getScorecard();

  const time = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Kolkata",
  }).format(new Date(checkedAt));

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Developer overview"
        subtitle="How the app itself is doing: what is deployed, how it is configured, and whether the database and monitoring are answering."
      />

      <FigureStrip>
        <Figure label="Passing" value={String(summary.pass)} tone={summary.pass > 0 ? "good" : undefined} note="Checked and fine" />
        <Figure
          label="Investigate"
          value={String(summary.investigate)}
          tone={summary.investigate > 0 ? "bad" : "good"}
          note="Degraded or down"
        />
        <Figure label="Unknown" value={String(summary.unknown)} note="Could not be answered" />
        <Figure label="Not configured" value={String(summary.notConfigured)} note="Switched off, not broken" />
      </FigureStrip>
      <p className="-mt-2 text-[11.5px] text-muted">
        Checked {time} IST. Reload for a fresh run. Nothing on this page calls a
        payment, SMS or push provider.
      </p>

      <div className="grid gap-4 @3xl:grid-cols-2">
        {groups.map((group) => (
          <Panel key={group.title} title={group.title} subtitle={group.subtitle}>
            <ul className="-mt-1">
              {group.rows.map((row) => (
                <HealthLine key={row.label} {...row} />
              ))}
            </ul>
          </Panel>
        ))}
      </div>

      <Panel title="Dig deeper" subtitle="Where each answer comes from.">
        <ul className="space-y-1.5 text-[13px]">
          <li>
            <Link className="font-semibold text-accent underline" href="/developer/observability">
              Observability
            </Link>{" "}
            <span className="text-muted">
              errors grouped by cause, orders, payments, delivery, alerts, incidents and logs.
            </span>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
