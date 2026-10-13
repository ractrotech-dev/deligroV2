import { AdminHero, Panel } from "@/components/admin/admin-ui";
import { FilterChips } from "@/components/admin/admin-filters";
import { MetricTable, NotMigratedNotice } from "@/components/developer/obs-ui";
import { getMetricRows } from "@/lib/obs/metrics";
import { OBS_HTTP_SAMPLE_RATE } from "@/lib/obs/emit";
import { OBS_RANGES, type ObsRange } from "@/lib/obs/read";

/**
 * Observability → API. Per-endpoint volume, error rate and latency.
 *
 * Built from `obs_metrics_rollup`, not from raw events, so it keeps working
 * past the 14-day raw window — the only way "is this worse than last month?"
 * stays answerable, which is the question that turns a number into a judgement.
 *
 * Two caveats are stated on the page rather than buried in a doc, because both
 * change how the figures should be read:
 *
 *   * **Call counts are sampled.** Fast successful requests are kept at 10%;
 *     anything that failed or took over a second is kept in full. So the error
 *     RATE is understated and the error COUNT is exact — which is the useful way
 *     round, and unusable if nobody says so.
 *   * **Percentiles across a window are approximate.** Each minute's p95 is
 *     exact; the figure here is the worst of them, which over-reports slightly.
 *     For a latency number that is the right direction to be wrong in.
 */
export const dynamic = "force-dynamic";

export default async function ApiPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const sp = await searchParams;
  const range = OBS_RANGES.some((r) => r.value === sp.range)
    ? (sp.range as ObsRange)
    : "24h";

  const [routes, domain] = await Promise.all([
    getMetricRows("route", range),
    getMetricRows("domain", range),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <AdminHero
        title="API"
        subtitle="Endpoints by volume, error rate and latency. Worst first — you opened this because something is wrong."
        tag={OBS_RANGES.find((r) => r.value === range)?.label}
      />

      {routes.unavailable ? <NotMigratedNotice /> : null}

      <FilterChips
        label="Window"
        options={OBS_RANGES.map((r) => ({ value: r.value, label: r.label }))}
        active={range}
        hrefFor={(v) => `/developer/observability/api${v ? `?range=${v}` : ""}`}
      />

      {/* Endpoints and business checkpoints answer the same question from
          two sides, so on a wide console they are read side by side rather
          than one scroll apart. Both carry a 560px table, so they only split
          once each half clears that. */}
      <div className="flex flex-col gap-4 @6xl:flex-row">
        <Panel
          className="min-w-0 flex-1"
          title="Endpoints"
          subtitle="Route templates, never concrete paths — an order id in this column would make per-endpoint aggregation impossible."
        >
          <MetricTable
            rows={routes.rows}
            keyHeader="Endpoint"
            hrefFor={(key) =>
              `/developer/observability/logs?route=${encodeURIComponent(key)}&range=${range}&level=warn`
            }
            emptyNote={
              routes.unavailable
                ? "Observability is not installed on this database."
                : "No requests recorded in this window. If the platform is serving traffic, check that the rollup job is running — System Health reports its age."
            }
          />
          <p className="mt-3 text-[11px] italic text-muted">
            Successful requests under one second are sampled at{" "}
            {Math.round(OBS_HTTP_SAMPLE_RATE * 100)}%; failures and slow requests are
            never sampled. So error counts are exact and total call counts are a
            tenth of reality — which makes the error <em>rate</em> here an
            understatement, not an overstatement.
          </p>
        </Panel>

        <Panel
          className="min-w-0 flex-1"
          title="Business checkpoints"
          subtitle="Named events rather than endpoints: order.created, payment.settle, dispatch.assign. Never sampled."
        >
          <MetricTable
            rows={domain.rows}
            keyHeader="Checkpoint"
            hrefFor={(key) =>
              `/developer/observability/logs?kind=domain&range=${range}&q=${encodeURIComponent(key)}`
            }
            emptyNote="No business checkpoints recorded in this window."
          />
        </Panel>
      </div>

    </div>
  );
}
