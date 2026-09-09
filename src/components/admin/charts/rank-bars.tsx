import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/**
 * A ranked comparison — top vendors by revenue, categories by volume — as a
 * horizontal bar list.
 *
 * ## Why this is not recharts
 *
 * Five labelled bars is a bar chart, and a chart library draws it no better
 * than a `<div>` with a width. What the library would add here is a 400KB
 * dependency, a client boundary, a `ResponsiveContainer` that needs a stated
 * height, and a label axis that truncates shop names to "Biryani Hous…". This
 * renders on the server, ships no JavaScript, wraps its labels, and puts the
 * figure where it can be read exactly rather than estimated against a scale.
 *
 * Recharts earns its place for a time series, where the shape between points is
 * the information. It does not earn it for a sorted list of five numbers.
 *
 * ## Reading it
 *
 * Bars are scaled against the largest value in the set, not against a total, so
 * the comparison is "how does second place compare to first" — the question a
 * ranking is actually asked. A `secondary` figure rides on the right for the
 * dimension that qualifies the first: orders behind revenue, revenue behind
 * order count.
 */

export interface RankRow {
  id: string;
  label: string;
  /** What the bar's length means. */
  value: number;
  /** Pre-formatted, because these are rupees on one screen and counts on another. */
  valueLabel: string;
  /** The qualifying figure, right-aligned: "142 orders", "₹412 avg". */
  secondary?: string;
  href?: string;
}

export function RankBars({
  rows,
  color = "var(--accent)",
  className,
}: {
  rows: RankRow[];
  color?: string;
  className?: string;
}) {
  // Guard the divide: an all-zero set (a brand-new platform, or a window with
  // no sales) would otherwise make every bar `NaN%` wide.
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;

  return (
    <ol className={cn("space-y-2", className)}>
      {rows.map((row, i) => {
        const body = (
          <>
            <div className="flex items-baseline gap-2.5">
              <span className="text-data w-3.5 shrink-0 text-[11px] font-semibold tabular-nums text-[color:var(--c-faint)]">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                {row.label}
              </span>
              <span className="text-data shrink-0 text-[12.5px] font-semibold tabular-nums text-ink">
                {row.valueLabel}
              </span>
              {row.secondary ? (
                <span className="text-data hidden w-[86px] shrink-0 text-right text-[11px] tabular-nums text-muted @sm:block">
                  {row.secondary}
                </span>
              ) : null}
            </div>
            <div
              className="mt-1.5 ml-6 h-[5px] overflow-hidden rounded-full bg-[var(--c-bar)]"
              aria-hidden
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max((row.value / max) * 100, row.value > 0 ? 2 : 0)}%`,
                  background: color,
                }}
              />
            </div>
          </>
        );

        return (
          <li key={row.id}>
            {row.href ? (
              <Link
                href={row.href}
                className="press -mx-1.5 block rounded-[var(--c-r-sm)] px-1.5 py-1 transition-colors hover:bg-[var(--c-hover)]"
              >
                {body}
              </Link>
            ) : (
              <div className="px-1.5 py-1">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
