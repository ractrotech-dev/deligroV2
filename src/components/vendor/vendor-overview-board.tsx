"use client";

import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  Radar,
  RadarChart,
  PolarAngleAxis,
  PolarGrid,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import { SectionTitle } from "@/components/roles/role-ui";
import {
  VendorHero,
  VendorMetricCard,
  VendorPanel,
} from "@/components/vendor/vendor-ui";
import type { VendorOverviewSummary } from "@/lib/data-access/vendor-overview";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { Phone, Users } from "lucide-react";

/** Theme tokens as CSS vars — stable refs, no getSnapshot churn. */
const C = {
  accent: "var(--accent)",
  green: "var(--green)",
  blue: "var(--blue)",
  muted: "var(--muted)",
  ink: "var(--ink)",
  surface: "var(--surface)",
  line: "var(--line)",
} as const;

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-52 items-center justify-center rounded-xl bg-surface-2 text-sm text-muted">
      {label}
    </div>
  );
}

function ChartTooltipBox({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  valueFormatter?: (n: number, name?: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 shadow-lg">
      {label ? (
        <p className="mb-1 text-[11px] font-semibold text-muted">{label}</p>
      ) : null}
      {payload.map((p, i) => (
        <p key={i} className="text-data text-sm font-bold text-ink">
          <span
            className="mr-1.5 inline-block size-2 rounded-full"
            style={{ background: p.color }}
          />
          {p.name ? `${p.name}: ` : ""}
          {valueFormatter
            ? valueFormatter(Number(p.value) || 0, p.name)
            : String(p.value)}
        </p>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="vendor-panel">
      <SectionTitle
        right={
          hint ? (
            <p className="max-w-[11rem] text-right text-[11px] font-medium leading-snug text-muted">
              {hint}
            </p>
          ) : null
        }
      >
        {title}
      </SectionTitle>
      {children}
    </section>
  );
}

function OrdersAreaChart({
  data,
}: {
  data: { day: string; orders: number }[];
}) {
  const gid = useId().replace(/:/g, "");
  const hasData = data.some((d) => d.orders > 0);
  if (!hasData) return <ChartEmpty label="No orders this week yet" />;

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id={`ordersFill-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.blue} stopOpacity={0.45} />
              <stop offset="100%" stopColor={C.blue} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={C.line} strokeDasharray="3 6" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: C.muted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: C.muted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip
            content={
              <ChartTooltipBox
                valueFormatter={(n) => `${n} order${n === 1 ? "" : "s"}`}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="orders"
            name="Orders"
            stroke={C.blue}
            strokeWidth={2.5}
            fill={`url(#ordersFill-${gid})`}
            activeDot={{ r: 5, fill: C.accent }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueLineChart({
  data,
}: {
  data: { day: string; revenue: number }[];
}) {
  const hasData = data.some((d) => d.revenue > 0);
  if (!hasData) return <ChartEmpty label="No revenue this week yet" />;

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid stroke={C.line} strokeDasharray="3 6" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: C.muted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: C.muted, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            tickFormatter={(v) =>
              v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
            }
          />
          <Tooltip
            content={
              <ChartTooltipBox valueFormatter={(n) => formatINR(n)} />
            }
          />
          <Line
            type="monotone"
            dataKey="revenue"
            name="Revenue"
            stroke={C.green}
            strokeWidth={2.5}
            dot={{ r: 3.5, fill: C.green, strokeWidth: 0 }}
            activeDot={{ r: 6, fill: C.accent }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendAreaChart({
  data,
}: {
  data: { label: string; orders: number; revenue: number }[];
}) {
  const gid = useId().replace(/:/g, "");
  const hasData = data.some((d) => d.orders > 0 || d.revenue > 0);
  if (!hasData) return <ChartEmpty label="Not enough history yet" />;

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id={`trendFill-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.accent} stopOpacity={0.4} />
              <stop offset="100%" stopColor={C.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={C.line} strokeDasharray="3 6" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: C.muted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: C.muted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip
            content={
              <ChartTooltipBox
                valueFormatter={(n, name) =>
                  name === "Revenue" ? formatINR(n) : `${n} orders`
                }
              />
            }
          />
          <Area
            type="monotone"
            dataKey="orders"
            name="Orders"
            stroke={C.accent}
            strokeWidth={2.5}
            fill={`url(#trendFill-${gid})`}
          />
          <Line
            type="monotone"
            dataKey="revenue"
            name="Revenue"
            stroke={C.green}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-[11px] text-muted">
        Solid = orders · dashed = revenue
      </p>
    </div>
  );
}

function DonutChart({
  data,
  centerLabel,
  centerValue,
  emptyLabel,
}: {
  data: { name: string; value: number; color: string }[];
  centerLabel: string;
  centerValue: string;
  emptyLabel: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return <ChartEmpty label={emptyLabel} />;

  return (
    <div className="w-full">
      <div className="relative h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="82%"
              paddingAngle={3}
              stroke={C.surface}
              strokeWidth={3}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              content={
                <ChartTooltipBox
                  valueFormatter={(n) =>
                    `${n} (${Math.round((n / total) * 100)}%)`
                  }
                />
              }
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-data text-xl font-bold">{centerValue}</p>
          <p className="text-[11px] font-medium text-muted">{centerLabel}</p>
        </div>
      </div>
      <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
        {data
          .filter((d) => d.value > 0)
          .map((d) => (
            <li
              key={d.name}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted"
            >
              <span
                className="size-2.5 rounded-full"
                style={{ background: d.color }}
              />
              {d.name}{" "}
              <span className="text-data font-semibold text-ink">{d.value}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

type TileProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  fill?: string;
  size?: number;
};

// Recharts Treemap tile renderer. Declared at module scope, not inside
// BestsellersTreemap's render — a component created during render remounts and
// loses state every frame (and the react-hooks lint rule rejects it).
function ProductTile(props: TileProps) {
  const { x = 0, y = 0, width = 0, height = 0, name, fill, size } = props;
  if (width < 4 || height < 4) return null;
  const showLabel = width > 48 && height > 36;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={8}
        fill={fill}
        fillOpacity={0.88}
      />
      {showLabel ? (
        <>
          <text
            x={x + 10}
            y={y + 18}
            fill="#fff"
            fontSize={11}
            fontWeight={700}
          >
            {String(name ?? "").length > 14
              ? `${String(name).slice(0, 12)}…`
              : name}
          </text>
          <text
            x={x + 10}
            y={y + 34}
            fill="rgba(255,255,255,0.9)"
            fontSize={10}
            fontWeight={600}
          >
            {size} sold
          </text>
        </>
      ) : null}
    </g>
  );
}

function BestsellersTreemap({
  data,
}: {
  data: { name: string; qty: number; revenue: number }[];
}) {
  if (data.length === 0) {
    return <ChartEmpty label="No item sales this month" />;
  }

  const palette = [
    C.accent,
    C.green,
    C.blue,
    "#c45c26",
    "#5a8f6b",
    "#4a6fa5",
    "#d4784a",
    C.muted,
  ];

  const treeData = data.map((p, i) => ({
    name: p.name,
    size: p.qty,
    revenue: p.revenue,
    fill: palette[i % palette.length],
  }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <Treemap
          data={treeData}
          dataKey="size"
          nameKey="name"
          stroke={C.surface}
          aspectRatio={4 / 3}
          content={<ProductTile />}
        >
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const p = payload[0].payload as {
                name: string;
                size: number;
                revenue: number;
              };
              return (
                <div className="rounded-xl border border-line bg-surface px-3 py-2 shadow-lg">
                  <p className="text-sm font-bold">{p.name}</p>
                  <p className="text-data text-xs text-muted">
                    {p.size} sold · {formatINR(p.revenue)}
                  </p>
                </div>
              );
            }}
          />
        </Treemap>
      </ResponsiveContainer>
      <p className="mt-2 text-center text-[11px] text-muted">
        Bigger tile = more sold this month
      </p>
    </div>
  );
}

function WeekRadarChart({
  stats,
}: {
  stats: VendorOverviewSummary;
}) {
  const data = [
    { metric: "Today", value: stats.todayOrders },
    { metric: "Week", value: stats.weekOrders },
    {
      metric: "Month",
      value: Math.round(stats.monthOrders / 4) || stats.monthOrders,
    },
    { metric: "Done", value: stats.completedMonth },
    { metric: "Kitchen", value: stats.pendingNow },
    { metric: "Repeat", value: stats.repeatCustomers },
  ];
  const hasData = data.some((d) => d.value > 0);
  if (!hasData) return <ChartEmpty label="No activity to map yet" />;

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid stroke={C.line} />
          <PolarAngleAxis
            dataKey="metric"
            tick={{ fill: C.muted, fontSize: 11 }}
          />
          <Radar
            name="Activity"
            dataKey="value"
            stroke={C.accent}
            fill={C.accent}
            fillOpacity={0.28}
            strokeWidth={2}
          />
          <Tooltip
            content={
              <ChartTooltipBox valueFormatter={(n) => String(n)} />
            }
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function VendorOverviewBoard({
  restaurantName,
  stats,
}: {
  restaurantName?: string;
  stats: VendorOverviewSummary;
}) {

  const daily = useMemo(
    () =>
      stats.daily.map((d) => ({
        day: d.day,
        orders: d.orders,
        revenue: d.revenue,
      })),
    [stats.daily]
  );

  const weekly = useMemo(
    () =>
      stats.weeklyTrend.map((w) => ({
        label: w.label,
        orders: w.orders,
        revenue: w.revenue,
      })),
    [stats.weeklyTrend]
  );

  const orderMix = useMemo(
    () =>
      [
        {
          name: "Completed",
          value: stats.completedMonth,
          color: C.green,
        },
        {
          name: "Cancelled",
          value: stats.cancelledMonth,
          color: C.muted,
        },
        {
          name: "In kitchen",
          value: stats.pendingNow,
          color: C.accent,
        },
      ].filter((d) => d.value > 0),
    [stats.completedMonth, stats.cancelledMonth, stats.pendingNow]
  );

  const oneTime = Math.max(0, stats.totalCustomers - stats.repeatCustomers);
  const customerMix = useMemo(
    () =>
      [
        {
          name: "Repeat",
          value: stats.repeatCustomers,
          color: C.green,
        },
        {
          name: "One-time",
          value: oneTime,
          color: C.blue,
        },
      ].filter((d) => d.value > 0),
    [stats.repeatCustomers, oneTime]
  );

  return (
    <>
      <VendorHero
        title="Overview"
        subtitle={
          restaurantName
            ? `${restaurantName} · simple charts for orders, items & customers.`
            : "Simple charts for orders, items & customers."
        }
        action={
          <div className="text-right">
            <p className="text-data text-sm font-bold">{stats.monthOrders}</p>
            {stats.monthChangePercent === null ? (
              <p className="text-[10px] font-medium text-muted">
                Orders this month
              </p>
            ) : (
              <p
                className={cn(
                  "text-[10px] font-bold",
                  stats.monthChangePercent >= 0 ? "text-green" : "text-red-500"
                )}
              >
                {stats.monthChangePercent >= 0 ? "▲" : "▼"}{" "}
                {Math.abs(stats.monthChangePercent)}% vs last month
              </p>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:gap-3 @3xl:grid-cols-4">
        <VendorMetricCard
          label="This week"
          value={String(stats.weekOrders)}
          hint={formatINR(stats.weekRevenue)}
        />
        <VendorMetricCard
          label="This month"
          value={String(stats.monthOrders)}
          hint={formatINR(stats.monthRevenue)}
        />
        <VendorMetricCard
          label="Customers"
          value={String(stats.totalCustomers)}
          hint={`${stats.customersThisMonth} this month`}
        />
        <VendorMetricCard
          label="Repeat buyers"
          value={String(stats.repeatCustomers)}
          hint={`${stats.pendingNow} in kitchen`}
        />
      </div>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <ChartCard title="Orders this week" hint="Area chart · rise = busier days">
          <OrdersAreaChart data={daily} />
        </ChartCard>
        <ChartCard
          title="Revenue this week"
          hint="Line chart · how money moved day by day"
        >
          <RevenueLineChart data={daily} />
        </ChartCard>
      </div>

      <ChartCard
        title="Last 4 weeks"
        hint={`${stats.todayOrders} today · avg order ${formatINR(stats.avgOrderValue)}`}
      >
        <TrendAreaChart data={weekly} />
      </ChartCard>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <ChartCard
          title="Bestsellers this month"
          hint="Treemap · larger block = more sold"
        >
          <BestsellersTreemap data={stats.topProducts} />
        </ChartCard>
        <ChartCard
          title="Order status mix"
          hint="Donut · share of completed vs cancelled"
        >
          <DonutChart
            data={orderMix}
            centerLabel="this month"
            centerValue={String(
              stats.completedMonth + stats.cancelledMonth || stats.monthOrders
            )}
            emptyLabel="No order mix yet"
          />
        </ChartCard>
      </div>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <ChartCard
          title="Customer loyalty"
          hint="Donut · who comes back vs one-time"
        >
          <DonutChart
            data={customerMix}
            centerLabel="customers"
            centerValue={String(stats.totalCustomers)}
            emptyLabel="No customers yet"
          />
        </ChartCard>
        <ChartCard
          title="Activity snapshot"
          hint="Radar · where your kitchen is strongest"
        >
          <WeekRadarChart stats={stats} />
        </ChartCard>
      </div>

      <VendorPanel
        title="Top customers this month"
        subtitle="Tap a phone number to call your best buyers"
        action={
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
            <Users className="size-3.5" />
            {stats.customersThisMonth} active
          </span>
        }
      >
        {stats.topCustomers.length === 0 ? (
          <div className="flex h-28 items-center justify-center rounded-xl bg-surface-2 text-sm text-muted">
            No customers this month yet
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {stats.topCustomers.map((c, i) => (
              <li
                key={c.id}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                  {c.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{c.name}</p>
                    {i === 0 ? (
                      <span className="rounded-full bg-green/15 px-2 py-0.5 text-[10px] font-bold uppercase text-green">
                        Best
                      </span>
                    ) : null}
                    {c.orders >= 2 ? (
                      <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[10px] font-bold uppercase text-accent">
                        Repeat
                      </span>
                    ) : null}
                  </div>
                  {c.phone ? (
                    <a
                      href={`tel:${c.phone.replace(/\s/g, "")}`}
                      className="mt-0.5 inline-flex items-center gap-1 text-xs text-accent"
                    >
                      <Phone className="size-3" />
                      {c.phone}
                    </a>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted">No phone on file</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-data text-sm font-bold">{c.orders}×</p>
                  <p className="text-[11px] text-muted">{formatINR(c.spent)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </VendorPanel>
    </>
  );
}
