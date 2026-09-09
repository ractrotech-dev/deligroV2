import Link from "next/link";
import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { FilterChips } from "@/components/admin/admin-filters";
import {
  Figure,
  FigureStrip,
  HealthLine,
  MetricTable,
  NotMigratedNotice,
} from "@/components/admin/obs-ui";
import {
  getDeliveryHealth,
  getMetricRows,
  getOrderHealth,
} from "@/lib/obs/metrics";
import { OBS_RANGES, type ObsRange } from "@/lib/obs/read";

/**
 * Observability → Delivery.
 *
 * Dispatch is best-effort by design and swallows its own failures — the module
 * says so in its own header — so before this page the only symptom of a broken
 * assignment was an order sitting at "ready" with nobody able to say why.
 *
 * The distinction that makes this page useful: **riders online but nothing
 * assigned** is a software problem, and **nobody online** is an operations one.
 * They look identical from the order side and need completely different people.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

export default async function DeliveryHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const sp = await searchParams;
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "24h";

  const [delivery, orders, domain] = await Promise.all([
    getDeliveryHealth(),
    getOrderHealth(range),
    getMetricRows("domain", range),
  ]);

  const dispatchRows = domain.rows.filter((r) => r.key.startsWith("dispatch."));
  const softwareProblem = delivery.unassigned > 0 && delivery.ridersOnline > 0;
  const staffingProblem = delivery.unassigned > 0 && delivery.ridersOnline === 0;

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="Delivery"
        subtitle="Assignment, offers and the orders nobody has picked up."
        tag={
          delivery.unassigned > 0
            ? `${delivery.unassigned} unassigned`
            : "All assigned"
        }
      />

      {delivery.unavailable ? <NotMigratedNotice /> : null}

      <FilterChips
        label="Window"
        options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
        active={range}
        hrefFor={(v) => `/admin/observability/delivery${v ? `?range=${v}` : ""}`}
      />

      {softwareProblem || staffingProblem ? (
        <div className="rounded-xl border border-pop/40 bg-[var(--c-tint-amber)] px-4 py-3.5">
          <p className="text-[13.5px] font-semibold text-ink">
            {softwareProblem
              ? "Riders are online but orders are unassigned"
              : "No riders online"}
          </p>
          <p className="mt-1 text-[12.5px] text-muted">
            {softwareProblem ? (
              <>
                Dispatch is not matching them. The likeliest cause is stale
                location: a rider whose last position fix is old is treated as
                having no position at all, so a fleet that has not granted the
                location permission looks like an empty fleet.
              </>
            ) : (
              <>
                This is an operations problem rather than a software one — there
                is nobody to assign to. Nothing on this page will fix it.
              </>
            )}
          </p>
        </div>
      ) : null}

      <FigureStrip>
        <Figure
          label="Out for delivery"
          value={nf.format(delivery.active)}
          note="Accepted, not yet delivered"
        />
        <Figure
          label="Riders carrying"
          value={nf.format(delivery.ridersOnline)}
          note="Distinct riders with a live delivery"
        />
        <Figure
          label="Offered, not accepted"
          value={nf.format(delivery.offeredNotAccepted)}
          note="First refusal is exclusive, then it opens to the pool"
        />
        <Figure
          label="Unassigned"
          value={nf.format(delivery.unassigned)}
          note="Nobody holds it and nobody has been asked"
          tone={delivery.unassigned > 0 ? "bad" : "good"}
        />
        <Figure
          label="Ready, waiting"
          value={nf.format(orders.readyNoRider.length)}
          note="Packed for over 20 minutes"
          tone={orders.readyNoRider.length > 0 ? "bad" : "good"}
        />
      </FigureStrip>

      {/* Checkpoints beside their caveats, for the same reason as
          Notifications: the second panel says how to read the first. */}
      <div className="flex flex-col gap-4 @6xl:flex-row">
        <Panel className="min-w-0 flex-1" title="Dispatch checkpoints">
          <MetricTable
            rows={dispatchRows}
            keyHeader="Checkpoint"
            hrefFor={(key) =>
              `/admin/observability/logs?kind=domain&range=${range}&q=${encodeURIComponent(key)}`
            }
            emptyNote="No dispatch events recorded in this window. Dispatch runs when a vendor accepts an order, so a quiet window can simply mean a quiet evening."
          />
        </Panel>

        <Panel className="min-w-0 flex-1" title="What this page cannot tell you">
          <ul className="-mt-1">
            <HealthLine
              label="Rider location accuracy"
              state="unknown"
              detail="Only the age of the last fix is known"
              note="A fix older than the dispatch window is treated as no fix. Whether it was accurate when it was taken is not something the server can check."
            />
            <HealthLine
              label="Why a rider declined"
              state="unknown"
              detail="Not recorded"
              note="An offer that expires and one that was actively refused look the same from here."
            />
          </ul>
          <p className="mt-3 text-[12px] text-muted">
            The live board on the{" "}
            <Link href="/admin" className="underline underline-offset-2">
              dashboard
            </Link>{" "}
            shows the same fleet from the operations side — who is where, rather
            than what failed.
          </p>
        </Panel>
      </div>

    </div>
  );
}
