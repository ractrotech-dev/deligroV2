import Link from "next/link";
import {
  getAdminDashboard,
  getAdminNavCounts,
  getFailedPaymentCount,
  listPendingRestaurants,
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
import { getLiveBoard } from "@/lib/data-access/admin-dispatch";
import { getSettlementStats } from "@/lib/data-access/admin-settlements";
import { listVendorRanking } from "@/lib/data-access/admin-vendor-ranking";
import {
  getPlatformEarnings,
  type PlatformEarnings,
} from "@/lib/data-access/admin-orders";
import {
  AttentionList,
  Empty,
  LiveBadge,
  MetricRow,
  PageHeader,
  Panel,
  Section,
  SectionCol,
  SectionRow,
  ShareBar,
  Tabs,
  type AttentionItem,
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
import { ConsoleOnly } from "@/components/admin/console-only";
import { LiveBoard } from "@/components/admin/live-board";
import { ApprovalQueue } from "@/components/admin/approval-queue";
import { RangeTabs } from "@/components/admin/admin-ui";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { formatINR, formatWaited } from "@/lib/utils/format";

/**
 * Admin home — the operations command centre.
 *
 * The screen is arranged around the six questions an operator opens it to ask,
 * in the order they ask them:
 *
 * 1. *How are we doing?* — the metric strip, six figures with their trend.
 * 2. *What needs me?* — the attention centre, worst queue first.
 * 3. *What is happening right now?* — the live feed, worst-late first.
 * 4. *What changed?* — the trend chart, switchable between revenue, orders and
 *    average order value.
 * 5. *Where is the business coming from?* — top vendors, order outcomes, and
 *    how people paid.
 * 6. *What can I clear from here?* — the approval queue, decided in place.
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
 * flight, and that is what the live feed and the attention centre report.
 * Inventing the rest on an operations screen would be worse than the gap.
 *
 * Platform earnings likewise gets a figure and a week-over-week delta, but no
 * sparkline and no place in the chart's metric switch: a per-day earnings
 * series needs a per-vendor rate recompute the series query does not do, and
 * deriving one from revenue would be arithmetic that looks like a measurement.
 *
 * ## One page, two shells
 *
 * The wrapping rows collapse to a single column inside the phone frame and
 * become the console's split at width. The chart and the live feed are
 * `ConsoleOnly`: both are console-scale, and both have a phone-readable
 * summary beside them that stays.
 */
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-IN");

/** How many rows each dashboard queue shows before deferring to its screen. */
const BOARD_ROWS = 8;
const APPROVALS_SHOWN = 4;
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
  pendingApprovals: 0,
  pendingRefunds: 0,
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

export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; metric?: string }>;
}) {
  const { days: daysParam, metric: metricParam } = await searchParams;
  const requested = Number(daysParam);
  const days = RANGES.some((r) => r.value === requested) ? requested : 7;
  const metric: TrendMetric = isTrendMetric(metricParam) ? metricParam : "revenue";

  const [
    dash,
    pending,
    series,
    mix,
    payments,
    board,
    counts,
    settlements,
    earnings,
    failedPayments,
    ranking,
  ] = await Promise.all([
    getAdminDashboard(),
    listPendingRestaurants(),
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
      ? getLiveBoard(BOARD_ROWS)
      : Promise.resolve({ rows: [], inFlight: 0, atRisk: 0, unassigned: 0 }),
    isSupabaseConfigured
      ? getAdminNavCounts().catch(() => NO_COUNTS)
      : Promise.resolve(NO_COUNTS),
    isSupabaseConfigured
      ? getSettlementStats().catch(() => ({ draftCount: 0 }))
      : Promise.resolve({ draftCount: 0 }),
    isSupabaseConfigured
      ? getPlatformEarnings().catch(() => NO_EARNINGS)
      : Promise.resolve(NO_EARNINGS),
    isSupabaseConfigured ? getFailedPaymentCount() : Promise.resolve(0),
    isSupabaseConfigured
      ? listVendorRanking().catch(() => null)
      : Promise.resolve(null),
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

  const metrics: MetricItem[] = [
    {
      label: "Revenue today",
      value: formatINR(dash.today.gmv),
      note: "vs same day last week",
      delta: {
        label: deltaLabel(dash.trends.gmv),
        direction: dash.trends.gmv.direction,
      },
      spark: spark.map((d) => d.gmv),
    },
    {
      label: "Orders today",
      value: nf.format(dash.today.orders),
      note: "vs same day last week",
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
      value: formatINR(basketToday),
      note: "per order today",
      // Deliberately no delta: a week-over-week average is not derivable from
      // the revenue and order trends without re-querying, and inferring one
      // from the other two would be arithmetic that looks like a measurement.
      spark: spark.map((d) => (d.orders > 0 ? Math.round(d.gmv / d.orders) : 0)),
    },
    {
      label: "Riders currently delivering",
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

  /* ---------- the attention centre ----------
     Only queues with something in them. A list of zeros is a list an operator
     learns to stop reading, and then the one that is not zero goes unread too. */
  const attention: AttentionItem[] = ([
    {
      href: "/admin/orders",
      title: "Orders with no rider",
      detail: "Nobody assigned after 8 minutes",
      count: board.unassigned,
      tone: "red",
      action: "View orders",
    },
    {
      href: "/admin/orders",
      title: "Deliveries running late",
      detail: "Past the time the customer was promised",
      count: board.atRisk,
      tone: "red",
      action: "View orders",
    },
    {
      href: "/admin/refunds",
      title: "Refunds to decide",
      detail: "Customers waiting on their money",
      count: counts.pendingRefunds,
      tone: "amber",
      action: "Open queue",
    },
    {
      href: "/admin/orders?status=PLACED",
      title: "Failed payments",
      detail: "Customer tried to pay and could not",
      count: failedPayments,
      tone: "amber",
      action: "View orders",
    },
    {
      href: "/admin/vendors",
      title: "Shops waiting to go live",
      detail: "Approved by nobody yet",
      count: pending.length,
      tone: "accent",
      action: "Review",
    },
    {
      href: "/admin/settlements",
      title: "Shop payments ready",
      detail: "Worked out, not sent yet",
      count: settlements.draftCount,
      tone: "blue",
      action: "Open drafts",
    },
    // Annotated on the array rather than on `attention`, so `tone` is checked
    // against the union here instead of being widened to `string` by inference
    // and only failing at the assignment.
  ] satisfies AttentionItem[]).filter((d) => d.count > 0);

  const attentionTotal = attention.reduce((sum, d) => sum + d.count, 0);

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

  /* ---------- approvals ---------- */
  const oldestWait = pending.length
    ? formatWaited(
        [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
          .createdAt
      )
    : null;

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
          <div className="hidden @3xl:block">
            <RangeTabs options={RANGES} active={days} hrefFor={rangeHref} />
          </div>
        }
      />

      <MetricRow items={metrics} />

      {/* What needs a person, and what is moving. The two questions an operator
          opens this page for, side by side and above everything analytical. */}
      <SectionRow>
        <SectionCol grow={1.7} basis={440}>
          <Section
            flush
            title="Happening now"
            meta={
              board.atRisk > 0
                ? `${board.atRisk} running late`
                : `${nf.format(board.inFlight)} in flight`
            }
            actions={
              <Link
                href="/admin/orders"
                className="press text-[11.5px] font-semibold text-accent-ink"
              >
                View all orders →
              </Link>
            }
          >
            {/* Console-only: a 720px table with no card fallback and no
                pagination — it scrolls sideways by design. The counts in the
                heading and the link stay on a phone, and /admin/orders is the
                same data in a form that stacks. */}
            <ConsoleOnly
              tool="The live order feed"
              why="View all orders, above, is the same orders in a list that stacks — that is the phone version of this."
            >
              <LiveBoard rows={board.rows} />
            </ConsoleOnly>
          </Section>
        </SectionCol>

        <SectionCol basis={300}>
          <Section
            flush
            title="Needs attention"
            meta={attentionTotal > 0 ? `${attentionTotal} waiting` : undefined}
          >
            <AttentionList items={attention} />
          </Section>
        </SectionCol>
      </SectionRow>

      {/* The analytical half. Everything below here answers "what changed" and
          "where is it coming from", which is a different mode of reading from
          the operational half above — hence the section rule between them. */}
      <Section
        title="Trend"
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
        <SectionRow>
          <SectionCol grow={1.7} basis={440}>
            <Panel bare className="p-[var(--c-pad-x)]">
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
              {/* The three figures above cover the same period and are the part
                  worth reading on a phone; a 30-day plot in a 370px column is
                  not, and it costs a charting library to draw. */}
              <ConsoleOnly
                tool="The trend chart"
                why="The three totals above it cover the same period, and they are the part worth reading on a phone anyway."
              >
                <div className="h-[220px]">
                  <TrendChart days={series.days} metric={metric} />
                </div>
              </ConsoleOnly>
            </Panel>
          </SectionCol>

          <SectionCol basis={300}>
            <Panel
              title="Top shops"
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
      </Section>

      <SectionRow>
        <SectionCol basis={260}>
          <Section
            flush
            title="Where orders ended up"
            meta={`${rangeLabel} · ${nf.format(mixTotal)} orders`}
          >
            <ShareBar segments={outcomes} />
          </Section>
        </SectionCol>

        <SectionCol basis={260}>
          <Section
            flush
            title="How people paid"
            meta={
              cashValue > 0
                ? `${rangeLabel} · ${formatINR(cashValue)} in cash`
                : rangeLabel
            }
            actions={
              <Link
                href="/admin/cash-ledger"
                className="press text-[11.5px] font-semibold text-accent-ink"
              >
                Cash ledger →
              </Link>
            }
          >
            <ShareBar segments={paymentSegments} noun="payments" />
          </Section>
        </SectionCol>

        <SectionCol grow={1.3} basis={300}>
          <Section
            flush
            id="pending"
            title="Shops waiting to go live"
            meta={oldestWait ? `longest wait ${oldestWait}` : undefined}
            actions={
              pending.length > APPROVALS_SHOWN ? (
                <Link
                  href="/admin/vendors"
                  className="press text-[11.5px] font-semibold text-accent-ink"
                >
                  All {pending.length} →
                </Link>
              ) : null
            }
          >
            <ApprovalQueue pending={pending} limit={APPROVALS_SHOWN} />
          </Section>
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
}: {
  label: string;
  value: string;
  on: boolean;
}) {
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
