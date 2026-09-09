"use client";

import dynamic from "next/dynamic";
import type { DailyPoint } from "@/lib/data-access/admin-series";
import type { TrendMetric } from "./chart-theme";

/**
 * Recharts, off the critical path of every screen that plots something.
 *
 * The library is roughly 400KB and was imported statically into pages that also
 * carry the metric strip, the live board and the approval queue — all of which
 * are what an operator actually opens the page for, and all of which waited on
 * it to hydrate. The chart sits below them, and the totals it plots are already
 * readable in the header above it.
 *
 * `ssr: false` needs a client component to live in, which is the only reason
 * this wrapper exists: the pages are server components and cannot pass that
 * option themselves.
 *
 * Second benefit, and the larger one on a phone: the real chart is rendered
 * inside `<ConsoleOnly>`, which blocks the *client mount* at phone width.
 * Because the chunk is fetched on mount rather than on import, a handset never
 * downloads Recharts at all, instead of downloading it and rendering nothing.
 */

const TrendChartImpl = dynamic(
  () => import("./trend-chart").then((m) => m.TrendChart),
  {
    ssr: false,
    // Matches the chart's own height so the panel does not resize when it
    // lands. A shifting card under the cursor is worse than a slow one.
    loading: () => (
      <div
        className="size-full animate-pulse rounded-[var(--c-r)] bg-surface-2"
        aria-hidden
      />
    ),
  }
);

export function TrendChart(props: {
  days: DailyPoint[];
  metric: TrendMetric;
  showVolume?: boolean;
  height?: number;
}) {
  return <TrendChartImpl {...props} />;
}
