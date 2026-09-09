import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * The header every console screen opens with, and the toolbar under it.
 *
 * ## One component, two shells
 *
 * Admin and vendor pages render in both the console and a ~370px phone frame,
 * so this cannot be a console-only component: a second `ConsoleHeader` would
 * mean every screen rendering two headers and hiding one. The switch is
 * `.admin-hero`'s container query in globals.css — inside the phone frame it is
 * the gradient card the portal has always used, and at console width it sheds
 * the card and becomes a plain title row.
 *
 * ## Why the title is small
 *
 * 20px, not 25px, and not a display size. An operations console is read all
 * day and the page title is the one thing on screen the operator already knows
 * — they navigated here. It has to establish the level, not win the page. The
 * figures below it are what should be immediately readable.
 *
 * ## Where the primary action lives
 *
 * Here, in `actions` — not in the top bar. The top bar used to carry a
 * hard-coded "New campaign" button, which meant every one of the forty-five
 * admin screens offered the same irrelevant action in its most prominent slot.
 * A page's primary action belongs to the page.
 */

export function PageHeader({
  title,
  description,
  /** Status beside the title: "Live", "18 in flight", "Cycle 12 Aug". */
  status,
  /** Fixed-size visual before the title — an avatar or logo tile. */
  leading,
  actions,
  back,
  className,
}: {
  title: string;
  description?: string;
  status?: React.ReactNode;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <header
      className={cn(
        "admin-hero relative overflow-hidden rounded-[var(--radius-sheet)] border border-line p-4",
        className
      )}
    >
      <div className="admin-hero-glow vendor-hero-glow pointer-events-none absolute inset-0" />
      <div className="relative">
        {back ? (
          <div className="mb-2.5">
            <Link
              href={back.href}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-ink"
            >
              <ArrowLeft className="size-3.5" />
              {back.label}
            </Link>
          </div>
        ) : null}

        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
          {leading ? <div className="shrink-0">{leading}</div> : null}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 className="text-[21px] font-extrabold tracking-[-0.025em] @3xl:text-[20px]">
                {title}
              </h1>
              {status}
            </div>
            {description ? (
              // Capped to a reading measure. The console runs to 1600px; an
              // uncapped one-line description becomes a single 1500px line of
              // 12px grey, which is the "mobile card stretched across a
              // desktop" look in miniature. A no-op in the phone frame.
              <p className="mt-1 max-w-[68ch] text-[13px] leading-snug text-muted @3xl:text-[12.5px]">
                {description}
              </p>
            ) : null}
          </div>

          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * The controls row: search, filters, tabs, a range switch.
 *
 * Sticks under the top bar in the console so a two-hundred-row list keeps the
 * controls that filter it, and goes static inside the phone frame, where there
 * is no console header to stick under and a blurred bar in a 370px column
 * costs more than it gives. Both behaviours are `.c-toolbar` in globals.css.
 */
export function Toolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("c-toolbar", className)}>{children}</div>;
}

/** Pushes what follows it to the right-hand end of a `Toolbar`. */
export function ToolbarGap() {
  return <span className="ml-auto" aria-hidden />;
}

export interface TabItem {
  href: string;
  label: string;
  /** Rendered dimmed beside the label. Omit rather than pass 0. */
  count?: number;
}

/**
 * The in-page view switch — All / Placed / Preparing / Delivered.
 *
 * Links, not state. The view has to survive a reload, be sendable to the
 * colleague you are on the phone to, and re-query on the server; a
 * `"use client"` segmented control gives up all three, and these pages are
 * server components that read the filter straight out of `searchParams`.
 */
export function Tabs({
  items,
  active,
  label,
  className,
}: {
  items: TabItem[];
  /** The href of the current view. */
  active: string;
  label: string;
  className?: string;
}) {
  return (
    <nav className={cn("c-tabs no-scrollbar", className)} aria-label={label}>
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === active ? "page" : undefined}
          className="c-tab"
        >
          {t.label}
          {typeof t.count === "number" ? (
            <span className="c-tab-count text-data">{t.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
