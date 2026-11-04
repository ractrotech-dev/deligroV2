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
  getOrderStatusMix,
  getPaymentMix,
  type AdminSeries,
  type PaymentSlice,
  type StatusSlice,
} from "@/lib/data-access/admin-series";
import { listVendorRanking } from "@/lib/data-access/admin-vendor-ranking";
import {
  getPlatformEarnings,
  type PlatformEarnings,
} from "@/lib/data-access/admin-orders";
import {
  Empty,
  MetricRow,
  PageHeader,
  Panel,
  SectionCol,
  SectionRow,
  ShareBar,
  Tabs,
  type MetricItem,
  type ShareSegment,
} from "@/components/admin/console";
import { RankBars, type RankRow } from "@/components/admin/charts/rank-bars";
import {
  TREND_METRICS,
  TREND_METRIC_ORDER,
  isTrendMetric,
  type TrendMetric,
} from "@/components/admin/charts/chart-theme";
import { TrendChart } from "@/components/admin/charts/lazy";
import { RangeTabs } from "@/components/admin/admin-ui";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR } from "@/lib/utils/format";

/**
 * Admin → Reports → Business numbers: how the business is doing. Moved here when
 * the dashboard became the order desk, so nothing was lost.
 *
 * Every number is counted from the database, so a quiet day reads as zero rather
 * than as a busy one. Nothing here is seeded, sampled or rounded up.
 *
 * ## What this screen deliberately does not show
 *
 * Average preparation time, average delivery time, and an on-time delivery
 * rate. There is no trustworthy completion stamp on an order — `minutesLate`
 * in `admin-orders` returns null for anything delivered or cancelled for
 * exactly this reason, and migration 0033 records that there is no usable
 * `orders.delivered_at`. Inventing them would be worse than the gap.
 *
 * Platform earnings likewise gets a figure and a week-over-week delta, but no
 * sparkline and no place in the chart's metric switch: a per-day earnings
 * series needs a per-vendor rate recompute the series query does not do, and
 * deriving one from revenue would be arithmetic that looks like a measurement.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

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

/** Without Supabase the optional sources answer empty, so a demo install renders zeros. */
function loadNumbers(days: number) {
  return Promise.all([
    getAdminDashboard(),
    isSupabaseConfigured
      ? getAdminSeries(days)
      : Promise.resolve<AdminSeries>(EMPTY_SERIES),
    isSupabaseConfigured
      ? getOrderStatusMix(days)
      : Promise.resolve<StatusSlice[]>([]),
    isSupabaseConfigured
      ? getPaymentMix(days)
      : Promise.resolve<PaymentSlice[]>([]),
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

export default async function BusinessNumbersPage({
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

  const [dash, series, mix, payments, counts, earnings, ranking] = await loadNumbers(days);

  const rangeLabel = RANGES.find((r) => r.value === days)?.label ?? `${days} days`;
  const rangeHref = (v: number) => hrefFor({ days: v, metric });
  const metricHref = (m: TrendMetric) => hrefFor({ days, metric: m });

  /* ---------- the metric strip ----------
     Three have a history to draw; riders on delivery and orders in flight are
     instantaneous states — nothing records what they were yesterday — so they
     get no sparkline rather than a fabricated one. */
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
      value: nf.format(counts.liveOrders),
      note: "placed, cooking, ready or on the way",
      href: "/admin",
    },
  ];

  /* ---------- outcome mix ---------- */
  const SLICE_COLOR: Record<string, string> = {
    placed: "var(--accent)",
    kitchen: "var(--accent)",
    ready: "var(--pop)",
    on_the_way: "var(--blue)",
    delivered: "var(--green)",
    cancelled: "var(--deal)",
  };
  const outcomes: ShareSegment[] = mix.map((s) => ({
    label: s.label,
    count: s.count,
    color: SLICE_COLOR[s.status] ?? "var(--c-faint)",
  }));
  const mixTotal = mix.reduce((sum, s) => sum + s.count, 0);

  /* ---------- payment mix ----------
     Counts, not value: the question this answers is how many doorstep cash
     handovers the riders are carrying, which is what Cash & expenses has to
     reconcile. The rupee figure rides in the section's meta line. */
  const paymentSegments: ShareSegment[] = payments.map((p) => ({
    label: p.label,
    count: p.count,
    color: p.method === "cod" ? "var(--pop)" : "var(--blue)",
  }));
  const cashValue = payments.find((p) => p.method === "cod")?.gmv ?? 0;

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
        title="Business numbers"
        description="Sales, earnings and where orders come from."
        actions={
          <>
            <Link href="/admin/reports" className="c-btn c-btn-outline">
              All reports
            </Link>
            <div className="block">
              <RangeTabs options={RANGES} active={days} hrefFor={rangeHref} />
            </div>
          </>
        }
      />

      <MetricRow items={metrics} />

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

      <SectionRow className="items-stretch">
        <SectionCol basis={300}>
          <Panel
            title="Where orders ended up"
            meta={`${rangeLabel} · ${nf.format(mixTotal)} orders`}
          >
            <ShareBar segments={outcomes} />
          </Panel>
        </SectionCol>
        <SectionCol basis={300}>
          <Panel
            title="How people paid"
            className="flex-1"
            meta={
              cashValue > 0
                ? `${rangeLabel} · ${formatINR(cashValue)} in cash`
                : rangeLabel
            }
            actions={
              <Link
                href="/admin/cash-ledger"
                className="text-[11.5px] font-semibold text-accent-ink"
              >
                Cash ledger →
              </Link>
            }
          >
            <ShareBar segments={paymentSegments} noun="payments" />
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
 * This screen's state is entirely in the URL — it is a server component and
 * re-queries when either control changes. Built in one place so a range switch
 * never drops the chosen metric.
 */
function hrefFor({ days, metric }: { days: number; metric: TrendMetric }): string {
  const params = new URLSearchParams();
  if (days !== 7) params.set("days", String(days));
  if (metric !== "revenue") params.set("metric", metric);
  const qs = params.toString();
  return qs ? `/admin/reports/overview?${qs}` : "/admin/reports/overview";
}
