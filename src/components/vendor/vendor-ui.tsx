"use client";

import {
  LiveBadge,
  PageHeader,
  StatusBadge,
} from "@/components/admin/console";
import { cn } from "@/lib/utils/cn";


export function LivePulse({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex size-2.5", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-green opacity-60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-green" />
    </span>
  );
}

/**
 * DEPRECATED — use `PageHeader` from `components/admin/console`.
 *
 * An adapter, for the same reason `AdminHero` is one: the partner hub is the
 * same console as the admin one, to the same owner, and two page headers in one
 * product is how they drift apart. Same prop mapping — `subtitle` becomes
 * `description`, `tag` and `badge` collapse into the single `status` slot that
 * serves both shells.
 *
 * Delete once the vendor screens are converted.
 */
export function VendorHero({
  title,
  subtitle,
  tag,
  badge,
  leading,
  action,
  live,
}: {
  title: string;
  subtitle?: string;
  tag?: string;
  badge?: React.ReactNode;
  leading?: React.ReactNode;
  action?: React.ReactNode;
  live?: boolean;
}) {
  return (
    <PageHeader
      title={title}
      description={subtitle}
      leading={leading}
      actions={action}
      status={
        live || tag || badge ? (
          <span className="flex flex-wrap items-center gap-2">
            {live ? <LiveBadge /> : null}
            {tag ? <StatusBadge>{tag}</StatusBadge> : badge}
          </span>
        ) : null
      }
    />
  );
}


/**
 * One figure on a vendor screen.
 *
 * Two things this used to draw are gone.
 *
 * The **progress bar** was the important one: `barPct` defaulted to 72 and most
 * callers took the default, so every metric on the overview screen showed a bar
 * filled to roughly three-quarters of nothing. A bar implies a denominator, and
 * these figures do not have one. Drawing a proportion of an unknown whole is a
 * chart that lies, which is worse on a shop's takings than on anything else in
 * this product. The prop is still accepted so call sites need not change, and
 * is ignored.
 *
 * The **icon tile** goes because a toned 36px glyph beside a two-word label
 * carries no information the label does not, and six of them in a row is the
 * loudest thing on the screen. `icon` and `tone` are likewise accepted and
 * unused rather than removed from ninety call sites in one commit.
 *
 * What is left is the console's own metric shape: label, figure, qualifier.
 */
export function VendorMetricCard({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "vendor-metric flex flex-col gap-1.5 text-left",
        onClick && "press cursor-pointer hover:border-[var(--c-border-hover)]"
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-[11.5px] font-semibold leading-tight text-muted">
          {label}
        </span>
        {hint ? (
          <span className="text-data shrink-0 text-[11px] font-semibold text-muted">
            {hint}
          </span>
        ) : null}
      </div>
      <p className="text-data truncate text-[22px] font-bold leading-none tracking-[-0.025em] tabular-nums text-ink">
        {value}
      </p>
    </Tag>
  );
}

export function VendorPanel({
  title,
  subtitle,
  action,
  children,
  className,
  accent,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  accent?: "accent" | "green" | "blue" | "muted" | "red";
}) {
  const accentBorder =
    accent === "green"
      ? "border-l-green"
      : accent === "blue"
        ? "border-l-blue"
        : accent === "muted"
          ? "border-l-line"
          : accent === "red"
            ? "border-l-red-500"
            : accent === "accent"
              ? "border-l-accent"
              : "";

  return (
    <section
      className={cn(
        "vendor-panel",
        accent && "border-l-4",
        accentBorder,
        className
      )}
    >
      {title ? (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function VendorChip({
  active,
  children,
  onClick,
  count,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  count?: number;
}) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "press inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all",
        active
          ? "border-accent bg-accent text-[var(--on-accent)] shadow-[var(--glow-accent)]"
          : "border-line bg-surface text-muted hover:border-accent/40 hover:text-ink"
      )}
    >
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            "grid min-w-5 place-items-center rounded-full px-1 text-[10px] font-bold",
            active ? "bg-white/20 text-white" : "bg-surface-2 text-muted"
          )}
        >
          {count}
        </span>
      ) : null}
    </Tag>
  );
}

/**
 * Nothing here, said in the space that would have held something.
 *
 * The 14px icon chip and the 200px centred column are gone. A vendor whose
 * "today" list is empty at 9am does not need a poster about it, and on the
 * orders board four of these stacked was most of the screen.
 */
export function VendorEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="c-empty flex-col !items-start gap-1">
      <p className="text-[12.5px] font-semibold text-ink">{title}</p>
      <p className="text-[11.5px] text-muted">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function VendorKanbanColumn({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: "accent" | "green" | "muted" | "red" | "blue";
  children: React.ReactNode;
}) {
  const headerTone =
    tone === "green"
      ? "text-green"
      : tone === "red"
        ? "text-red-500"
        : tone === "blue"
          ? "text-blue"
          : tone === "accent"
            ? "text-accent"
            : "text-muted";

  return (
    <div className="vendor-kanban-col flex min-h-[200px] flex-col rounded-[var(--radius-block)] border border-line bg-surface-2/50 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className={cn("text-xs font-bold uppercase tracking-wider", headerTone)}>
          {title}
        </h3>
        <span className="grid min-w-6 place-items-center rounded-full bg-surface px-2 py-0.5 text-xs font-bold shadow-sm">
          {count}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3">{children}</div>
    </div>
  );
}
