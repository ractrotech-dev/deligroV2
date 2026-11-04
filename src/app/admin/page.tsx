import { requireRole } from "@/lib/auth";
import Link from "next/link";
import {
  getAdminDashboard,
  getAdminNavCounts,
  type AdminNavCounts,
  type Trend,
} from "@/lib/data-access/admin-stats";
import {
  ALL_TIME,
  getAdminSeries,
  type AdminSeries,
} from "@/lib/data-access/admin-series";
import { getLiveBoard } from "@/lib/data-access/admin-dispatch";
import { EmergencyBanner } from "@/components/ops/emergency-banner";
import type { EmergencyItem } from "@/components/ops/emergency-types";
import { listEmergenciesAction } from "@/app/manager/support-actions";
import { listVendorRanking } from "@/lib/data-access/admin-vendor-ranking";
import {
  getPlatformEarnings,
  type PlatformEarnings,
} from "@/lib/data-access/admin-orders";
import {
  Empty,
  LiveBadge,
  MetricRow,
  PageHeader,
  Panel,
  SectionCol,
  SectionRow,
  Tabs,
  type MetricItem,
} from "@/components/admin/console";
import { RankBars, type RankRow } from "@/components/admin/charts/rank-bars";
import {
  TREND_METRICS,
  TREND_METRIC_ORDER,
  isTrendMetric,
  type TrendMetric,
} from "@/components/admin/charts/chart-theme";
import { TrendChart } from "@/components/admin/charts/lazy";
import { LiveBoard } from "@/components/admin/live-board";
import { RangeTabs } from "@/components/admin/admin-ui";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";

/**
 * Admin home — the operations command centre.
 *
 * The screen is arranged around the questions an operator opens it to ask,
 * in the order they ask them:
 *
 * 1. *How are we doing?* — the metric strip, six figures with their trend.
 * 2. *What needs me?* — any rider emergency (an SOS or a safety report: red,
 *    polled, with sound).
 * 3. *What is happening right now?* — the live feed, worst-late first.
 * 4. *What changed?* — the trend chart, switchable between revenue, orders and
 *    average order value.
 * 5. *Where is the business coming from?* — top vendors.
 *
 * Every number is counted from the database, so a quiet day reads as zero
 * rather than as a busy one. Nothing here is seeded, sampled or rounded up.
 *
 * ## What this screen deliberately does not show
 *
 * Average preparation time, average delivery time, and an on-time delivery
 * rate. There is no trustworthy completion stamp on an order — `minutesLate`
 * in `admin-orders` returns null for anything delivered or cancelled for
 * exactly this reason, and migration 0033 records that there is no usable
 * `orders.delivered_at`. What *is* real is lateness among orders still in
 * flight, and that is what the live feed reports.
 * Inventing the rest on an operations screen would be worse than the gap.
 *
 * Platform earnings likewise gets a figure and a week-over-week delta, but no
 * sparkline and no place in the chart's metric switch: a per-day earnings
 * series needs a per-vendor rate recompute the series query does not do, and
 * deriving one from revenue would be arithmetic that looks like a measurement.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

/** How many rows each dashboard queue shows before deferring to its screen. */
const BOARD_ROWS = 8;
const TOP_VENDORS = 5;

const RANGES = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: ALL_TIME, label: "All time" },
];

const EMPTY_SERIES: AdminSeries = {
  days: [],
  totals: { orders: 0, gmv: 0 },
  peak: null,
  olderOrders: 0,
};

const NO_COUNTS: AdminNavCounts = {
  liveOrders: 0,
};

const NO_EARNINGS: PlatformEarnings = {
  today: 0,
  trend: { pct: 0, direction: "flat" },
};

/** "8.4%" / "2.1%" / "0%" — the arrow is drawn separately by TrendIndicator. */
function deltaLabel(t: Trend): string {
  return t.direction === "flat" ? "0%" : `${Math.abs(t.pct)}%`;
}

/**
 * Every source the page reads, fetched in parallel. Without Supabase configured
 * the optional ones answer empty, so a demo install renders zeros rather than
 * failing. Called only after the page's `requireRole("admin")`.
 */
function loadOverview(days: number) {
  return Promise.all([
    getAdminDashboard(),
    isSupabaseConfigured
      ? getAdminSeries(days)
      : Promise.resolve<AdminSeries>(EMPTY_SERIES),
    isSupabaseConfigured
      ? getLiveBoard(BOARD_ROWS)
      : Promise.resolve({ rows: [], inFlight: 0, atRisk: 0 }),
    isSupabaseConfigured
      ? getAdminNavCounts().catch(() => NO_COUNTS)
      : Promise.resolve(NO_COUNTS),
    isSupabaseConfigured
      ? getPlatformEarnings().catch(() => NO_EARNINGS)
      : Promise.resolve(NO_EARNINGS),
    isSupabaseConfigured
      ? listVendorRanking().catch(() => null)
      : Promise.resolve(null),
  ]);
}

export default async function AdminOverviewPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ days?: string; metric?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { days: daysParam, metric: metricParam } = await searchParams;
  const requested = Number(daysParam);
  const days = RANGES.some((r) => r.value === requested) ? requested : 7;
  const metric: TrendMetric = isTrendMetric(metricParam) ? metricParam : "revenue";

  const [
    [
      dash,
      series,
      board,
      counts,
      earnings,
      ranking,
    ],
    emergencies,
  ] = await Promise.all([
    loadOverview(days),
    // Open rider emergencies (0087). Its failure costs only the banner.
    isSupabaseConfigured
      ? listEmergenciesAction().catch(() => [] as EmergencyItem[])
      : Promise.resolve([] as EmergencyItem[]),
  ]);

  const now = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  const rangeLabel = RANGES.find((r) => r.value === days)?.label ?? `${days} days`;
  const rangeHref = (v: number) =>
    hrefFor({ days: v, metric });
  const metricHref = (m: TrendMetric) => hrefFor({ days, metric: m });

  /* ---------- the metric strip ----------
     Six figures. Three have a history to draw; riders on delivery and orders in
     flight are instantaneous states — nothing records what they were yesterday
     — so they get no sparkline rather than a fabricated one. */
  const spark = series.days.slice(-7);
  const basketToday =
    dash.today.orders > 0 ? Math.round(dash.today.gmv / dash.today.orders) : 0;

  // The orders read behind revenue, orders and AOV failed: say so, never ₹0.
  const salesUnavailable = dash.today.salesUnavailable;
  const UNAVAILABLE_NOTE = "Couldn't load — refresh to retry";

  const metrics: MetricItem[] = [
    {
      label: "Revenue today",
      value: salesUnavailable ? "—" : formatINR(dash.today.gmv),
      note: salesUnavailable ? UNAVAILABLE_NOTE : "vs same day last week",
      delta: {
        label: deltaLabel(dash.trends.gmv),
        direction: dash.trends.gmv.direction,
      },
      spark: spark.map((d) => d.gmv),
    },
    {
      // Not the manager dashboard's "Today's Orders", which counts cancelled
      // orders too: the label says which this is.
      label: "Orders today (excl. cancelled)",
      value: salesUnavailable ? "—" : nf.format(dash.today.orders),
      note: salesUnavailable ? UNAVAILABLE_NOTE : "vs same day last week",
      delta: {
        label: deltaLabel(dash.trends.orders),
        direction: dash.trends.orders.direction,
      },
      spark: spark.map((d) => d.orders),
      href: "/admin/orders",
    },
    {
      label: "Platform earnings today",
      value: formatINR(earnings.today),
      note: "commission + GST + charges",
      delta: {
        label: deltaLabel(earnings.trend),
        direction: earnings.trend.direction,
      },
    },
    {
      label: "Average order value",
      value: salesUnavailable ? "—" : formatINR(basketToday),
      note: salesUnavailable ? UNAVAILABLE_NOTE : "per order today",
      // Deliberately no delta: a week-over-week average is not derivable from
      // the revenue and order trends without re-querying, and inferring one
      // from the other two would be arithmetic that looks like a measurement.
      spark: spark.map((d) => (d.orders > 0 ? Math.round(d.gmv / d.orders) : 0)),
    },
    {
      // The manager dashboard's "Active Riders" means every rider; this is
      // only those carrying an order right now.
      label: "Riders on delivery",
      value: nf.format(dash.today.activeRiders),
      note: `of ${nf.format(dash.totals.drivers)} riders`,
    },
    {
      label: "Orders in flight",
      value: nf.format(board.inFlight || counts.liveOrders),
      note: board.atRisk > 0 ? `${board.atRisk} running late` : "all on time",
      href: "/admin/orders",
    },
  ];

  /* ---------- top vendors ----------
     `listVendorRanking` counts delivered orders over its own rolling 30-day
     window, which is not this page's range. The section says so rather than
     letting the heading imply the range switch applies to it. */
  const topVendors: RankRow[] = (ranking?.vendors ?? [])
    .filter((v) => v.sales > 0)
    .sort((a, b) => b.sales - a.sales)
    .slice(0, TOP_VENDORS)
    .map((v) => ({
      id: v.id,
      label: v.name,
      value: v.sales,
      valueLabel: formatINR(v.sales),
      secondary: `${nf.format(v.orders)} order${v.orders === 1 ? "" : "s"}`,
      href: `/admin/vendors/${v.id}`,
    }));

  const chartMeta =
    series.olderOrders > 0
      ? `Last ${series.days.length} days · ${nf.format(series.olderOrders)} earlier orders not shown`
      : rangeLabel;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Live operational overview · ${now} IST`}
        status={<LiveBadge />}
        actions={
          <div className="block">
            <RangeTabs options={RANGES} active={days} hrefFor={rangeHref} />
          </div>
        }
      />

      {/* A rider in danger outranks everything on this screen. Renders nothing
          when there is no open emergency; polls on its own, like the queue. */}
      <EmergencyBanner items={emergencies} poll basePath="/admin/support" className="mb-4" />

      <MetricRow items={metrics} />

      {/* Full width: seven columns are read together here, and beside another
          panel they would scroll sideways. */}
      <Panel
        bare
        title="Live orders"
        meta={
          board.atRisk > 0
            ? `${board.atRisk} running late`
            : `${nf.format(board.inFlight)} in flight`
        }
        actions={
          <Link
            href="/admin/orders"
            className="text-[11.5px] font-semibold text-accent-ink"
          >
            View all orders →
          </Link>
        }
      >
        <div className="px-[var(--c-pad-x)] pb-3">
          <LiveBoard rows={board.rows} />
        </div>
      </Panel>

      <SectionRow className="items-stretch">
        <SectionCol grow={1.7} basis={440}>
          <Panel
            title="Trend"
            className="flex-1"
            meta={chartMeta}
            actions={
              <Tabs
                label="Chart metric"
                active={metricHref(metric)}
                items={TREND_METRIC_ORDER.map((m) => ({
                  href: metricHref(m),
                  label: TREND_METRICS[m].label,
                }))}
              />
            }
          >
            <div className="mb-3 flex flex-wrap items-baseline gap-x-7 gap-y-2">
              <Headline
                label="Revenue"
                value={formatINR(series.totals.gmv)}
                on={metric === "revenue"}
              />
              <Headline
                label="Orders"
                value={nf.format(series.totals.orders)}
                on={metric === "orders"}
              />
              <Headline
                label="Avg order value"
                value={formatINR(
                  series.totals.orders > 0
                    ? Math.round(series.totals.gmv / series.totals.orders)
                    : 0
                )}
                on={metric === "aov"}
              />
            </div>
            <div className="h-[220px]">
              <TrendChart days={series.days} metric={metric} />
            </div>
          </Panel>
        </SectionCol>

        <SectionCol basis={300}>
          <Panel
            title="Top shops"
            className="flex-1"
            meta={
              ranking ? `by revenue · last ${ranking.windowDays} days` : undefined
            }
          >
            {topVendors.length ? (
              <RankBars rows={topVendors} />
            ) : (
              <Empty action={{ href: "/admin/vendors", label: "Open vendors" }}>
                No shop has recorded a delivered order in this window.
              </Empty>
            )}
          </Panel>
        </SectionCol>
      </SectionRow>

    </>
  );
}

/**
 * One of the chart's three window totals. The plotted one is stated in full
 * ink; the other two recede but stay readable, because the point of showing
 * all three is that the comparison does not need a click.
 */
function Headline({
  label,
  value,
  on,
}: Readonly<{
  label: string;
  value: string;
  on: boolean;
}>) {
  return (
    <div>
      <p
        className={
          on
            ? "text-data text-[20px] font-bold leading-none tracking-[-0.025em] tabular-nums text-ink"
            : "text-data text-[20px] font-bold leading-none tracking-[-0.025em] tabular-nums text-muted"
        }
      >
        {value}
      </p>
      <p className="mt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
        {label}
      </p>
    </div>
  );
}

/**
 * The dashboard's state is entirely in the URL — the page is a server component
 * and re-queries when either control changes, so that is the only place the
 * choice can honestly live. Built in one place so a range switch never drops
 * the chosen metric, which is what happens when each control writes its own
 * query string.
 */
function hrefFor({ days, metric }: { days: number; metric: TrendMetric }): string {
  const params = new URLSearchParams();
  if (days !== 7) params.set("days", String(days));
  if (metric !== "revenue") params.set("metric", metric);
  const qs = params.toString();
  return qs ? `/admin?${qs}` : "/admin";
}
