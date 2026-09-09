"use client";

import { useId } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyPoint } from "@/lib/data-access/admin-series";
import {
  AXIS,
  CHART,
  TREND_METRICS,
  tickGap,
  type TrendMetric,
} from "./chart-theme";

/**
 * The console's time-series chart: one metric drawn, all of them readable.
 *
 * ## What the switch changes, and what it does not
 *
 * Switching between Revenue, Orders and Avg order value changes which series
 * is *plotted* — but the tooltip always shows all three for the day under the
 * cursor. A dashboard where the answer to "was that a big day or a busy day"
 * depends on which tab you happen to be on is a dashboard that makes you click
 * to think. Emphasis is the switch's job; withholding the other numbers is not.
 *
 * ## Why there is a Y axis now
 *
 * The chart this replaced hid both axes and put the window totals in the card
 * header, on the argument that a total can be read where a scale can only be
 * estimated. That is true of a *total* and false of a *shape*: without a scale,
 * a plot of a quiet week and a plot of a record week are the same picture. The
 * axis is four compact ticks in lakh notation, which costs about thirty pixels.
 *
 * ## Every point is counted
 *
 * `admin-series` zero-fills the days with no orders, so a quiet fortnight draws
 * as a flat line rather than as a gap that compresses into a busy-looking one.
 * Nothing here is sampled, smoothed or extrapolated.
 */
export function TrendChart({
  days,
  metric,
  /** Draws order volume as muted bars behind the line. */
  showVolume = true,
  height,
}: {
  days: DailyPoint[];
  metric: TrendMetric;
  showVolume?: boolean;
  height?: number;
}) {
  const gradientId = useId();
  const spec = TREND_METRICS[metric];

  if (!days.some((d) => d.orders > 0 || d.gmv > 0)) {
    return (
      <div className="flex h-full min-h-[140px] items-center justify-center rounded-[var(--c-r)] border border-dashed border-line px-6 text-center text-[12.5px] text-muted">
        No orders in this window yet.
      </div>
    );
  }

  const data = days.map((d) => ({
    label: d.label,
    date: d.date,
    value: spec.valueOf(d),
    orders: d.orders,
    gmv: d.gmv,
    aov: d.orders > 0 ? Math.round(d.gmv / d.orders) : 0,
  }));

  // The busiest day is the one worth finding again; everything else is context
  // for it. Only meaningful when the volume bars are drawn.
  const peak = data.reduce(
    (best, d) => (d.orders > (best?.orders ?? -1) ? d : best),
    null as (typeof data)[number] | null
  );

  // Drawing volume behind the line is redundant when the line already *is*
  // volume, and the two encodings of one number read as two series.
  const volume = showVolume && metric !== "orders";

  return (
    <ResponsiveContainer width="100%" height={height ?? "100%"}>
      <ComposedChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={spec.color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={spec.color} stopOpacity={0.01} />
          </linearGradient>
        </defs>

        <CartesianGrid stroke={CHART.grid} vertical={false} />

        <XAxis
          dataKey="label"
          interval={tickGap(data.length)}
          dy={4}
          {...AXIS}
        />
        <YAxis
          yAxisId="value"
          width={48}
          tickFormatter={spec.tick}
          domain={[0, (max: number) => Math.ceil(max * 1.12)]}
          {...AXIS}
        />
        {/* Volume rides on its own hidden scale so the bars stay a backdrop:
            sharing the value axis would make a 400-order day a bar the height
            of a ₹400 revenue day, which is a coincidence of units, not a fact. */}
        <YAxis
          yAxisId="volume"
          hide
          domain={[0, (max: number) => max * 3.2]}
        />

        <Tooltip
          cursor={{ fill: "var(--c-hover)" }}
          content={<TrendTooltip metric={metric} />}
        />

        {volume ? (
          <Bar yAxisId="volume" dataKey="orders" radius={[3, 3, 0, 0]} maxBarSize={26}>
            {data.map((d) => (
              <Cell
                key={d.date}
                fill={peak && d.date === peak.date ? CHART.barPeak : CHART.bar}
              />
            ))}
          </Bar>
        ) : null}

        {metric === "orders" ? (
          <Bar yAxisId="value" dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={30}>
            {data.map((d) => (
              <Cell
                key={d.date}
                fill={peak && d.date === peak.date ? spec.color : CHART.bar}
              />
            ))}
          </Bar>
        ) : (
          <Area
            yAxisId="value"
            type="monotone"
            dataKey="value"
            stroke={spec.color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 0 }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

interface TooltipPayload {
  payload?: { orders: number; gmv: number; aov: number };
}

/**
 * All three figures for the day, with the plotted one first.
 *
 * A day with no orders says so rather than reporting "₹0 average order value",
 * which would be a claim about basket size on a day when nobody bought
 * anything.
 */
function TrendTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  metric: TrendMetric;
}) {
  const day = payload?.[0]?.payload;
  if (!active || !day) return null;

  const rows: { key: TrendMetric; value: string }[] = [
    { key: "revenue", value: TREND_METRICS.revenue.format(day.gmv) },
    { key: "orders", value: TREND_METRICS.orders.format(day.orders) },
    {
      key: "aov",
      value: day.orders > 0 ? TREND_METRICS.aov.format(day.aov) : "—",
    },
  ];
  rows.sort((a, b) => (a.key === metric ? -1 : b.key === metric ? 1 : 0));

  return (
    <div className="rounded-[var(--c-r)] border border-line bg-surface px-2.5 py-2 shadow-[var(--shadow-md)]">
      {label ? (
        <p className="mb-1.5 text-[11px] font-semibold text-muted">{label}</p>
      ) : null}
      <dl className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline gap-3">
            <dt
              className={
                r.key === metric
                  ? "text-[11px] font-semibold text-ink"
                  : "text-[11px] text-muted"
              }
            >
              {TREND_METRICS[r.key].label}
            </dt>
            <dd
              className={
                r.key === metric
                  ? "text-data ml-auto text-[12.5px] font-bold tabular-nums text-ink"
                  : "text-data ml-auto text-[11.5px] tabular-nums text-muted"
              }
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {day.orders === 0 ? (
        <p className="mt-1.5 text-[10.5px] text-muted">No orders this day.</p>
      ) : null}
    </div>
  );
}
