"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, UtensilsCrossed, X } from "lucide-react";
import { ConsoleThemeToggle } from "@/components/admin/console/chrome";
import {
  ADMIN_NAV,
  ADMIN_NAV_GROUPS,
  activeNavItem,
} from "@/components/admin/admin-nav";
import type { AdminNavCounts } from "@/lib/data-access/admin-stats";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { cn } from "@/lib/utils/cn";

/**
 * The sidebar, as a slide-over, for web-mode viewports too narrow to hold a
 * permanent rail (roughly 480–1024px — a small laptop or a tablet). Below 480
 * the shell falls back to the phone frame entirely, so this never has to serve
 * as a phone menu.
 *
 * Carries `console-theme` itself: it renders as a sibling of the shell rather
 * than inside it, so it would otherwise fall back to the app's default palette
 * and open as a white panel over a warm-paper console.
 *
 * Closes on route change: without it, tapping a destination leaves the panel
 * covering the page you just asked for.
 */
export function AdminNavDrawer({
  open,
  theme,
  onClose,
  counts,
}: {
  open: boolean;
  /** The console palette variant — the drawer sits outside the shell div. */
  theme?: string;
  onClose: () => void;
  counts: AdminNavCounts;
}) {
  const pathname = usePathname();
  // Same longest-match rule as the rail — see AdminSidebar.
  const current = activeNavItem(pathname);

  useEffect(() => {
    onClose();
  }, [pathname, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="console-theme fixed inset-0 z-50 lg:hidden" data-console={theme}>
      <button
        aria-label="Close navigation"
        onClick={onClose}
        className="animate-fade-in absolute inset-0 bg-black/50"
      />
      <div className="absolute inset-y-0 left-0 flex w-[248px] max-w-[85vw] flex-col bg-[var(--sb-bg)] shadow-[var(--shadow-lg)]">
        <div className="flex items-center gap-[9px] px-4 pb-4 pt-[18px]">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-accent text-sm font-bold text-[var(--on-accent)]">
            D
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold leading-none tracking-[-0.01em] text-white">
              Deligro
            </span>
            <span className="mt-1 block truncate text-[10px] font-medium uppercase leading-none tracking-[0.06em] text-[var(--sb-group)]">
              Ops console
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="press grid size-7 shrink-0 place-items-center rounded-md text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav
          className="no-scrollbar flex-1 overflow-y-auto px-2 py-1"
          aria-label="Admin navigation"
        >
          {ADMIN_NAV_GROUPS.map((group) => {
            const items = ADMIN_NAV.filter((i) => i.group === group);
            if (!items.length) return null;
            return (
              <div key={group}>
                <p className="px-2 pb-[5px] pt-3.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--sb-group)]">
                  {group}
                </p>
                <ul className="space-y-px">
                  {items.map((item) => {
                    const active = current?.href === item.href;
                    const count = item.badge ? counts[item.badge] : 0;
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-[9px] rounded-[7px] px-[9px] py-[7px] text-[13px] transition-colors",
                            active
                              ? "bg-[var(--sb-active)] font-semibold text-white"
                              : "font-medium text-[var(--sb-text)] hover:bg-[var(--sb-hover)] hover:text-white"
                          )}
                        >
                          <Icon className="size-[15px] shrink-0" strokeWidth={1.7} />
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {count > 0 ? (
                            <span className="text-data shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-[var(--sb-text)]">
                              {count > 99 ? "99+" : count}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-[var(--sb-border)] px-3 py-3">
          {/* Same session, different surface — see AdminSidebar. */}
          <Link
            href="/"
            className="press mb-1 flex items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
          >
            <UtensilsCrossed className="size-4" strokeWidth={1.7} />
            Customer app
          </Link>

          <div className="flex items-center justify-between gap-2">
            {/* The *console's* palette, not the app's. This panel is console chrome;
                offering the customer app's light/dark switch here would change
                a surface the operator cannot even see from this screen. */}
            <ConsoleThemeToggle className="text-[var(--sb-meta)] hover:bg-[var(--sb-hover)] hover:text-white" />
            {isSupabaseConfigured ? (
              <form action="/auth/signout?next=/admin/login" method="post">
                <button
                  type="submit"
                  className="press flex items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
                >
                  <LogOut className="size-4" strokeWidth={1.7} />
                  Sign out
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
