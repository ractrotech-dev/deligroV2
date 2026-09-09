import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/**
 * The console's figures: a hairline-divided strip of metrics, and the sparkline
 * and delta that give one a direction.
 *
 * A metric here is deliberately *not* a card. Six cards in a row is six borders,
 * six radii and six fills competing with the number each of them exists to
 * show. The strip draws one outline and lets the container's background show
 * through 1px gaps — see `.c-metrics` in globals.css, which also explains why
 * that beats a per-cell ring at the rounded corners.
 */

/* ============================================================
   Sparkline
   ============================================================ */

/**
 * A 26px trend line. Inline SVG rather than a chart library: there are up to
 * six of these above the fold, none is interactive, and
 * `preserveAspectRatio="none"` plus a non-scaling stroke gives a line that
 * stretches to any column width without the stroke stretching with it.
 *
 * Fewer than two points is not a trend, so it draws nothing rather than a flat
 * line implying "no change".
 */
export function Sparkline({
  points,
  tone = "flat",
  className,
}: {
  points: number[];
  tone?: "up" | "down" | "flat";
  className?: string;
}) {
  if (points.length < 2) return null;

  const max = Math.max(...points);
  const min = Math.min(...points);
  // A perfectly flat series has no range to normalise against; draw it down the
  // middle rather than dividing by zero.
  const span = max - min || 1;
  const stepX = 120 / (points.length - 1);

  const xy = points.map((p, i) => {
    const x = i * stepX;
    const y = 24 - ((p - min) / span) * 22;
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });

  const line = `M${xy.join(" L")}`;
  const area = `${line} L120 26 L0 26 Z`;

  const stroke =
    tone === "up"
      ? "var(--c-spark-up)"
      : tone === "down"
        ? "var(--c-spark-down)"
        : "var(--c-faint)";

  return (
    <svg
      viewBox="0 0 120 26"
      preserveAspectRatio="none"
      className={cn("block h-[26px] w-full", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d={area} fill={stroke} fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ============================================================
   Delta
   ============================================================ */

export interface Delta {
  /** Pre-formatted, because not every delta is a percentage ("+6", "+0.8pp"). */
  label: string;
  direction: "up" | "down" | "flat";
  /**
   * Set when rising is the bad outcome — late deliveries, cancellations. Only
   * affects colour; the arrow still points the way the number actually moved.
   */
  invert?: boolean;
}

/** Which way a delta should *read*, once `invert` is taken into account. */
export function deltaTone(d: Delta): "up" | "down" | "flat" {
  if (d.direction === "flat") return "flat";
  const good = d.invert ? d.direction === "down" : d.direction === "up";
  return good ? "up" : "down";
}

export function TrendIndicator({
  delta,
  className,
}: {
  delta: Delta;
  className?: string;
}) {
  const tone = deltaTone(delta);
  return (
    <span
      className={cn(
        "text-data shrink-0 text-[11px] font-semibold tabular-nums",
        tone === "up"
          ? "text-green"
          : tone === "down"
            ? "text-deal"
            : "text-muted",
        className
      )}
    >
      {delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "—"}{" "}
      {delta.label}
    </span>
  );
}

/* ============================================================
   Metric strip
   ============================================================ */

export interface MetricItem {
  label: string;
  value: string;
  /** Small grey qualifier under the value: "per order", "of 140 riders". */
  note?: string;
  delta?: Delta;
  /** Omitted when the metric has no history to draw. Never fabricated. */
  spark?: number[];
  /** Makes the whole cell a link to the screen that explains the figure. */
  href?: string;
}

export function MetricRow({
  items,
  className,
}: {
  items: MetricItem[];
  className?: string;
}) {
  if (!items.length) return null;

  return (
    <div className={cn("c-metrics", className)}>
      {items.map((m) => {
        const tone = m.delta ? deltaTone(m.delta) : "flat";

        const body = (
          <>
            <div className="flex items-baseline justify-between gap-2">
              {/* Sentence case, wrapping rather than truncating. These labels
                  are plain English — "Riders currently delivering", not
                  "RIDERS ON DELIVERY" — and a sentence clipped to
                  "RIDERS CURRENTLY DELIV…" is harder to read than the jargon
                  it replaced. */}
              <span className="min-w-0 text-[11.5px] font-semibold leading-tight text-muted">
                {m.label}
              </span>
              {m.delta ? <TrendIndicator delta={m.delta} /> : null}
            </div>

            <div className="min-w-0">
              <p className="c-metric-value truncate">{m.value}</p>
              {m.note ? (
                <p className="mt-1.5 truncate text-[11.5px] text-muted">
                  {m.note}
                </p>
              ) : null}
            </div>

            {m.spark ? <Sparkline points={m.spark} tone={tone} /> : null}
          </>
        );

        return m.href ? (
          <Link key={m.label} href={m.href} className="c-metric press">
            {body}
          </Link>
        ) : (
          <div key={m.label} className="c-metric">
            {body}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   Inline figures
   ============================================================ */

/**
 * The small label / figure pair used in a band above a table, where the strip
 * would be too heavy. Half the height of a `MetricRow` cell and no sparkline —
 * these summarise the list below them, they are not the subject of the page.
 */
export function Figure({
  label,
  value,
  note,
  className,
}: {
  label: string;
  value: string | number;
  note?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
        {label}
      </p>
      <p className="text-data mt-1 truncate text-[17px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </p>
      {note ? (
        <p className="mt-1 truncate text-[11px] leading-snug text-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** A row of `Figure`s that reflows rather than squashing. */
export function FigureRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-4",
        className
      )}
    >
      {children}
    </div>
  );
}
