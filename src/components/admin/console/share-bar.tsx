import { cn } from "@/lib/utils/cn";
import { Empty } from "./empty";

/**
 * Composition, as one bar and its legend.
 *
 * Answers "where did orders end up" or "how did people pay" without a donut. A
 * donut of five slices needs a legend to be readable at all, at which point the
 * legend is doing the work and the ring is decoration; and reading a share off
 * a curved segment is harder than reading the number that is already written
 * next to it. So the legend *is* the table — swatch, label, count, share — and
 * the bar above it carries the one thing a table cannot: the shape of the
 * split, at a glance.
 *
 * Segments at zero keep their legend row (an operator wants to know a stage is
 * empty) but draw no bar segment, because a 0%-wide sliver still paints a
 * visible line at these sizes and would read as a small non-zero share.
 */

export interface ShareSegment {
  label: string;
  count: number;
  /** Any CSS colour — callers pass a token, so it follows the theme. */
  color: string;
}

export function ShareBar({
  segments,
  /** What the figures are, for the empty case: "orders", "payments". */
  noun = "orders",
  className,
}: {
  segments: ShareSegment[];
  noun?: string;
  className?: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (!total) return <Empty>No {noun} in this window.</Empty>;

  return (
    <div className={className}>
      <div className="flex h-[7px] gap-0.5 overflow-hidden rounded-full">
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <span
              key={s.label}
              style={{
                width: `${(s.count / total) * 100}%`,
                background: s.color,
              }}
              className="first:rounded-l-full last:rounded-r-full"
            />
          ))}
      </div>
      <dl className="mt-3 space-y-[7px]">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2.5">
            <span
              className={cn("size-2 shrink-0 rounded-[3px]", !s.count && "opacity-35")}
              style={{ background: s.color }}
            />
            <dt
              className={cn(
                "min-w-0 flex-1 truncate text-[12.5px]",
                s.count ? "text-ink" : "text-muted"
              )}
            >
              {s.label}
            </dt>
            <dd className="text-data shrink-0 text-[12.5px] tabular-nums text-ink">
              {s.count.toLocaleString("en-IN")}
            </dd>
            <dd className="text-data w-[40px] shrink-0 text-right text-[11.5px] tabular-nums text-muted">
              {Math.round((s.count / total) * 100)}%
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
