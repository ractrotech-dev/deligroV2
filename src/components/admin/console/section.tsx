import { cn } from "@/lib/utils/cn";

/**
 * Grouping without cards.
 *
 * The console used to say "these things belong together" by drawing a bordered,
 * rounded, padded container around them. On a screen with eight ideas that is
 * eight boxes, and the boxes end up louder than anything inside them. These
 * primitives say it with a hairline, a label and some space instead — see
 * `.c-sec` in globals.css.
 *
 * `Panel` is still here, and is still the right answer sometimes: a chart needs
 * an edge for its own coordinate space to sit inside, and a form reads better
 * bounded than floating. The rule is that a box has to earn itself, rather than
 * being the default shape of "a bit of page".
 *
 * All of these are pure presentational server components — no hooks, no
 * handlers — so they render on either side of the RSC boundary.
 */

/* ============================================================
   Section
   ============================================================ */

export function Section({
  title,
  meta,
  description,
  actions,
  /** Drops the top hairline. For the first section under a page header. */
  flush,
  id,
  className,
  children,
}: {
  title?: string;
  /** The count / range / timestamp that qualifies the title, on its baseline. */
  meta?: React.ReactNode;
  /** A sentence under the title, when the title alone is not enough. */
  description?: string;
  actions?: React.ReactNode;
  flush?: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("c-sec", flush && "c-sec-plain", id && "scroll-mt-20", className)}
    >
      {title || actions ? (
        <div className="c-sec-head">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {title ? <h2 className="c-sec-title">{title}</h2> : null}
            {meta ? <span className="c-sec-meta">{meta}</span> : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {description ? (
        <p className="-mt-1 max-w-prose text-[12px] leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Two or more sections side by side, collapsing to one column when the
 * container is narrow — which inside the phone frame it always is.
 *
 * A wrapping flex row rather than a grid, precisely so it *can* collapse: a
 * fixed `grid-cols-3` in a 370px column is three unreadable slivers.
 */
export function SectionRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start gap-x-6 gap-y-4", className)}>
      {children}
    </div>
  );
}

/**
 * A column inside a `SectionRow`.
 *
 * `grow` is the share of leftover width it claims against its siblings — 1.6
 * against 1 is the console's working split, a table and its rail. `basis` is
 * the width below which it wraps to its own line instead of squashing.
 */
export function SectionCol({
  grow = 1,
  basis = 320,
  children,
  className,
}: {
  grow?: number;
  basis?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-3.5", className)}
      style={{ flexGrow: grow, flexBasis: basis }}
    >
      {children}
    </div>
  );
}

/* ============================================================
   Panel
   ============================================================ */

/**
 * The bordered box, for content that needs an edge: a chart, a form, a table
 * that is not already inside `DataTable`'s own frame.
 *
 * Deliberately quieter than the `.card` it replaces — an 8px radius, a hairline
 * and no shadow at all. Depth in this console comes from value, never from
 * elevation.
 */
export function Panel({
  title,
  meta,
  description,
  actions,
  /** Removes the inner padding, for a panel whose child owns its own edges. */
  bare,
  className,
  id,
  children,
}: {
  title?: string;
  meta?: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  bare?: boolean;
  className?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        // Its own container: a chart in a one-third column has to lay itself
        // out against that column, not against the page.
        "@container c-panel",
        !bare && "c-panel-pad",
        id && "scroll-mt-20",
        className
      )}
    >
      {title || actions ? (
        <div
          className={cn(
            "c-sec-head",
            description ? "mb-1.5" : "mb-3",
            bare && "px-[var(--c-pad-x)] pt-3"
          )}
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {title ? <h2 className="c-sec-title">{title}</h2> : null}
            {meta ? <span className="c-sec-meta">{meta}</span> : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {description ? (
        <p
          className={cn(
            "mb-3 max-w-prose text-[11.5px] leading-relaxed text-muted",
            bare && "px-[var(--c-pad-x)]"
          )}
        >
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * A panel sized to hold a chart. Charts need a stated height — a recharts
 * `ResponsiveContainer` inside an auto-height parent collapses to zero — so
 * this is the one place in the kit that takes a pixel value.
 */
export function ChartPanel({
  title,
  meta,
  actions,
  height = 220,
  className,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  height?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel title={title} meta={meta} actions={actions} className={className}>
      <div style={{ height }}>{children}</div>
    </Panel>
  );
}
