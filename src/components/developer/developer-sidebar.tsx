"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import {
  DEVELOPER_NAV,
  DEVELOPER_NAV_GROUPS,
  activeDeveloperNavItem,
} from "@/components/developer/developer-nav";
import { RailToggle, useConsoleChrome } from "@/components/admin/console/chrome";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { initials } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * The Developer panel's rail. Same look as the admin console's (it shares the
 * console palette) with its own navigation and no operations counts: there is
 * no work queue here, only the state of the app.
 */
export function DeveloperSidebar({
  name,
  email,
}: Readonly<{
  name: string;
  email: string | null;
}>) {
  const pathname = usePathname();
  const { rail } = useConsoleChrome();
  const compact = rail === "compact";
  const current = activeDeveloperNavItem(pathname);

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
            href="/developer"
            className="press flex min-w-0 items-center gap-[9px]"
            aria-label="Deligro developer panel"
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
                  Developer panel
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
          aria-label="Developer navigation"
        >
          {DEVELOPER_NAV_GROUPS.map((group, groupIndex) => {
            const items = DEVELOPER_NAV.filter((i) => i.group === group);
            if (!items.length) return null;
            return (
              <div key={group}>
                {compact ? (
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
                  {items.map((item) => {
                    const Icon = item.icon;
                    const active = current?.href === item.href;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          aria-label={compact ? item.label : undefined}
                          title={compact ? item.label : undefined}
                          className={cn(
                            "relative flex items-center rounded-[7px] text-[12.5px] transition-colors duration-[120ms]",
                            compact
                              ? "h-9 justify-center"
                              : "gap-[9px] px-[9px] py-[7px]",
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
                            <span className="min-w-0 flex-1 truncate">
                              {item.label}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
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

          {compact || !isSupabaseConfigured ? null : (
            <form action="/auth/signout?next=/developer/login" method="post">
              <button
                type="submit"
                className="press flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-[11.5px] font-semibold text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
              >
                <LogOut className="size-[15px]" strokeWidth={1.7} />
                Sign out
              </button>
            </form>
          )}
        </div>
      </div>
    </aside>
  );
}
