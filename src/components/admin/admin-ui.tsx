import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  ChartPanel,
  LiveBadge,
  PageHeader,
  Panel as ConsolePanel,
  StatusBadge,
} from "@/components/admin/console";
import { cn } from "@/lib/utils/cn";

/**
 * Shared admin dashboard primitives — the admin section's answer to
 * `vendor-ui`. Every admin page is built from these so the whole portal reads
 * as one product: a gradient hero header, toned metric cards, titled panels and
 * a common empty state. All are pure presentational components (no hooks, no
 * handlers) so they render in both server and client components.
 */

/** Pulsing green dot — the "live" tell borrowed from the vendor portal. */
export function LiveDot({ className }: Readonly<{ className?: string }>) {
  return (
    <span className={cn("relative flex size-2", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-green opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-green" />
    </span>
  );
}

/** Muted "← Parent" link that sits above a sub-page hero. */
export function BackLink({
  href,
  children,
}: Readonly<{
  href: string;
  children: React.ReactNode;
}>) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft className="size-4" />
      {children}
    </Link>
  );
}

/**
 * DEPRECATED — use `PageHeader` from `components/admin/console`.
 *
 * Kept as an adapter, not as a second implementation. Forty-three screens call
 * this, and swapping them all in one commit would make the redesign
 * unreviewable; leaving two real headers behind would be worse still, because
 * the next person could not tell which one the console actually renders. So
 * there is exactly one header, and this maps the old prop names onto it.
 *
 * The mapping, and what changed:
 *
 * - `subtitle` → `description`, `tag` → `status`, `action` → `actions`,
 *   `backHref`/`backLabel` → `back`.
 * - `badge` was the phone frame's coloured pill and rendered *only* there,
 *   while `tag` was the console's outlined chip — and every caller passed the
 *   same content to both, so one of the two was always dead weight.
 *   `PageHeader` has one status slot serving both shells; `tag` wins when a
 *   caller passes both, because that is the one the console was showing.
 *
 * Delete this once the last call site is converted.
 */
export function AdminHero({
  title,
  subtitle,
  tag,
  badge,
  leading,
  action,
  live,
  backHref,
  backLabel,
}: Readonly<{
  title: string;
  subtitle?: string;
  tag?: string;
  badge?: React.ReactNode;
  leading?: React.ReactNode;
  action?: React.ReactNode;
  live?: boolean;
  backHref?: string;
  backLabel?: string;
}>) {
  return (
    <PageHeader
      title={title}
      description={subtitle}
      leading={leading}
      actions={action}
      back={backHref ? { href: backHref, label: backLabel ?? "Back" } : undefined}
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
 * DEPRECATED — use `Panel` (a box) or `Section` (no box) from
 * `components/admin/console`.
 *
 * An adapter over the kit's `Panel`, for the same reason `AdminHero` is one.
 * Choosing between the two at each call site is the actual work of the
 * redesign — most of these are groupings that want a hairline and a label, not
 * a bordered container — and that is a judgement per screen, not a rename.
 */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  id,
}: Readonly<{
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}>) {
  return (
    <ConsolePanel
      id={id}
      title={title}
      description={subtitle}
      actions={action}
      className={className}
    >
      {children}
    </ConsolePanel>
  );
}

/**
 * The centred empty state, for a screen that is empty *in its entirety* — a
 * console with no vendors at all, a first run, a section nobody has used yet.
 *
 * It is the wrong shape for a filtered list that came back with nothing, which
 * is where most of its call sites were: an operator who has just narrowed a
 * search does not need a poster, they need to know it is empty and to widen the
 * filter. `Empty` in the console kit is that — one dashed line where the rows
 * would have been. This is what stays for the genuine case.
 *
 * Retuned to console proportions either way. The old version was a 12-unit icon
 * tile above 15px copy in a 40-unit-tall box, which on a dense screen read as a
 * second page rather than as an absence on this one.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: Readonly<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}>) {
  return (
    // `ui-empty` is the console's hook — this component is shared with the
    // customer app, so its radius is retuned by CSS rather than changed here.
    <div className="ui-empty flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-surface px-4 py-8 text-center">
      <span className="mb-1 grid size-9 place-items-center rounded-[var(--c-r)] bg-surface-2 text-muted">
        <Icon className="size-[18px]" />
      </span>
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="max-w-[46ch] text-[12px] leading-relaxed text-muted">
        {description}
      </p>
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}

/**
 * DEPRECATED — use `ChartPanel` from `components/admin/console`.
 */
export function ChartCard({
  title,
  subtitle,
  action,
  height = 260,
  children,
  className,
}: Readonly<{
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  height?: number;
  children: React.ReactNode;
  className?: string;
}>) {
  return (
    <ChartPanel
      title={title}
      meta={subtitle}
      actions={action}
      height={height}
      className={className}
    >
      {children}
    </ChartPanel>
  );
}

/**
 * The window a screen is reporting on, as links rather than state — the page is
 * a server component and re-queries when the range changes, so the URL is the
 * only place the choice can honestly live.
 */
export function RangeTabs({
  options,
  active,
  hrefFor,
}: Readonly<{
  options: { value: number; label: string }[];
  active: number;
  hrefFor: (value: number) => string;
}>) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 text-xs"
      role="group"
      aria-label="Reporting window"
    >
      {options.map((o) => {
        const on = o.value === active;
        return (
          <Link
            key={o.value}
            href={hrefFor(o.value)}
            aria-current={on ? "true" : undefined}
            className={cn(
              "press whitespace-nowrap rounded-md px-[11px] py-[5px] transition-colors",
              on
                ? "bg-ink font-semibold text-[color:var(--surface)]"
                : "font-medium text-muted hover:text-ink"
            )}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

/** A soft "preview mode / apply migration" notice used across admin pages. */
export function PreviewNotice({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <p className="rounded-xl border border-pop/40 bg-pop/10 px-3.5 py-3 text-sm font-medium text-ink">
      {children}
    </p>
  );
}
