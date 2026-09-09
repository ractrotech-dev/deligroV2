"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, UtensilsCrossed } from "lucide-react";
import {
  RailToggle,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import {
  ADMIN_NAV,
  ADMIN_NAV_GROUPS,
  activeNavItem,
  type AdminNavItem,
  type BadgeKey,
} from "@/components/admin/admin-nav";
import type { AdminNavCounts } from "@/lib/data-access/admin-stats";
import type { ConsoleHealth } from "@/lib/console-health";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { initials } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * The web console's left rail — the piece the phone shell has no room for.
 *
 * Grouped rather than flat: an operator scanning for "where do I approve a
 * shop" is looking for a category first and a label second. Badges are live
 * counts (see `getAdminNavCounts`) so the rail doubles as the work queue.
 *
 * ## Two widths
 *
 * Full (208px) and compact (56px icons). The choice is a cookie resolved in the
 * layout, so a collapsed rail is collapsed in the first byte of HTML rather
 * than snapping shut after hydration — the same discipline the shell mode and
 * the palette use, and for the same reason.
 *
 * In compact mode the group headings become hairlines. A 56px column cannot
 * carry the word "Operations", and dropping the labels entirely would leave
 * seventeen icons in one undifferentiated stack; a rule between groups keeps
 * the grouping that the label was there to express.
 *
 * ## The active state
 *
 * A left accent bar plus a surface tint, not a filled capsule. Seventeen
 * entries with one of them filled is a strong mark, but it competes with the
 * badges beside it; a 2px rule reads instantly at the page edge and leaves the
 * colour budget to the counts, which are the part that changes.
 *
 * Dark in both palettes — it is chrome, not content, and the contrast at the
 * page edge is what stops the eye there.
 */
export function AdminSidebar({
  counts,
  health,
  name,
  email,
}: {
  counts: AdminNavCounts;
  health: ConsoleHealth;
  name: string;
  email: string | null;
}) {
  const pathname = usePathname();
  const { rail } = useConsoleChrome();
  const compact = rail === "compact";

  // One winner per route. Settings matches its own sub-pages, so asking each
  // item independently would highlight both Settings and Team on
  // /settings/employees.
  const current = activeNavItem(pathname);

  return (
    <aside className="admin-sidebar hidden lg:flex">
      <div
        className={cn(
          "flex h-full flex-col bg-[var(--sb-bg)] transition-[width] duration-150",
          compact ? "w-[56px]" : "w-[208px]"
        )}
      >
        <div
          className={cn(
            "flex items-center gap-[9px] px-3 pb-3 pt-4",
            compact && "justify-center px-0"
          )}
        >
          <Link
            href="/admin"
            className="press flex min-w-0 items-center gap-[9px]"
            aria-label="Deligro ops console"
          >
            <span className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-accent text-sm font-bold text-[var(--on-accent)]">
              D
            </span>
            {compact ? null : (
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-bold leading-none tracking-[-0.01em] text-white">
                  Deligro
                </span>
                <span className="mt-1 block truncate text-[9.5px] font-medium uppercase leading-none tracking-[0.08em] text-[var(--sb-group)]">
                  Ops console
                </span>
              </span>
            )}
          </Link>
        </div>

        <nav
          className={cn(
            "no-scrollbar flex-1 overflow-y-auto py-1",
            compact ? "px-1.5" : "px-2"
          )}
          aria-label="Admin navigation"
        >
          {ADMIN_NAV_GROUPS.map((group, groupIndex) => {
            const items = ADMIN_NAV.filter((i) => i.group === group);
            if (!items.length) return null;
            return (
              <div key={group}>
                {compact ? (
                  // The heading, as a rule. Skipped above the first group,
                  // where there is nothing to separate it from.
                  groupIndex > 0 ? (
                    <hr
                      className="mx-2 my-2 border-0 border-t border-[var(--sb-border)]"
                      aria-hidden
                    />
                  ) : null
                ) : (
                  <p className="px-2 pb-[5px] pt-3.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--sb-group)]">
                    {group}
                  </p>
                )}
                <ul className="space-y-px">
                  {items.map((item) => (
                    <li key={item.href}>
                      <NavLink
                        item={item}
                        active={current?.href === item.href}
                        count={item.badge ? counts[item.badge] : 0}
                        compact={compact}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div
          className={cn(
            "mt-auto flex flex-col gap-2",
            compact ? "items-center p-1.5" : "p-2.5"
          )}
        >
          {compact ? null : <SystemCard health={health} />}

          <div
            className={cn(
              "flex items-center gap-2.5",
              compact && "flex-col gap-1.5"
            )}
          >
            <span
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[11px] font-bold text-[var(--on-accent)]"
              title={email ? `${name} · ${email}` : name}
            >
              {initials(name)}
            </span>
            {compact ? null : (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-semibold text-white">
                  {name}
                </span>
                {email ? (
                  <span className="block truncate text-[10.5px] leading-tight text-[var(--sb-meta)]">
                    {email}
                  </span>
                ) : null}
              </span>
            )}
            <RailToggle />
          </div>

          {compact ? null : (
            <>
              {/* The way back to the app. An operator here is often also a
                  customer — the owner's phone is both — and leaving the console
                  used to mean signing out of it. Same session, different
                  surface. */}
              <FootLink href="/" icon={UtensilsCrossed}>
                Customer app
              </FootLink>

              {isSupabaseConfigured ? (
                <form action="/auth/signout?next=/admin/login" method="post">
                  <button
                    type="submit"
                    className="press flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-[11.5px] font-semibold text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
                  >
                    <LogOut className="size-[15px]" strokeWidth={1.7} />
                    Sign out
                  </button>
                </form>
              ) : null}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function FootLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="press flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-[11.5px] font-semibold text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
    >
      <Icon className="size-[15px]" strokeWidth={1.7} />
      {children}
    </Link>
  );
}

/**
 * Which queues read as urgent. Approvals and refunds are work sitting on a
 * person; live orders is activity, not a to-do, so it stays neutral however
 * high it climbs — an orange 60 next to Orders on a busy evening would train
 * the operator to ignore the colour that matters.
 */
const HOT: BadgeKey[] = ["pendingApprovals", "pendingRefunds"];

function NavLink({
  item,
  active,
  count,
  compact,
}: {
  item: AdminNavItem;
  active: boolean;
  count: number;
  compact: boolean;
}) {
  const Icon = item.icon;
  const hot = item.badge ? HOT.includes(item.badge) : false;

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      // The label is the accessible name in both widths. Without this a
      // collapsed rail is seventeen links called nothing.
      aria-label={compact ? item.label : undefined}
      title={compact ? item.label : undefined}
      className={cn(
        "relative flex items-center rounded-[7px] text-[12.5px] transition-colors duration-[120ms]",
        compact ? "h-9 justify-center" : "gap-[9px] px-[9px] py-[7px]",
        active
          ? "bg-[var(--sb-active)] font-semibold text-[var(--sb-text-active)]"
          : "font-medium text-[var(--sb-text)] hover:bg-[var(--sb-hover)] hover:text-white"
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent"
        />
      ) : null}

      <Icon className="size-[16px] shrink-0" strokeWidth={1.7} />

      {compact ? null : (
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      )}

      {count > 0 ? (
        compact ? (
          // No room for a figure, so the fact that there *is* a queue is what
          // gets shown. The number is one hover (or one expand) away.
          <span
            aria-hidden
            className={cn(
              "absolute right-1 top-1 size-1.5 rounded-full",
              hot ? "bg-accent" : "bg-[var(--sb-meta)]"
            )}
          />
        ) : (
          <span
            className={cn(
              "text-data shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums",
              hot
                ? "bg-accent/25 text-[#ff9a5a]"
                : "bg-white/10 text-[var(--sb-text)]"
            )}
          >
            {count > 99 ? "99+" : count}
          </span>
        )
      ) : null}
    </Link>
  );
}

/** Configuration health for this deployment — see lib/console-health. */
function SystemCard({ health }: { health: ConsoleHealth }) {
  const bad = health.rows.filter((r) => !r.ok).length;
  return (
    <div className="rounded-[8px] border border-[var(--sb-border)] px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[var(--sb-group)]">
          System
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-[10.5px] font-semibold",
            health.ok ? "text-[var(--sb-ok)]" : "text-[#ffa060]"
          )}
        >
          <span
            className="c-dot"
            style={{ background: health.ok ? "var(--sb-ok)" : "#ffa060" }}
          />
          {health.ok ? "All green" : `${bad} to set up`}
        </span>
      </div>
      <dl className="mt-1.5 space-y-1">
        {health.rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-2"
          >
            <dt className="text-[10.5px] text-[var(--sb-meta)]">{row.label}</dt>
            <dd
              className={cn(
                "text-data truncate text-[10.5px]",
                row.ok ? "text-[#e8e6e1]" : "text-[#ffa060]"
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
