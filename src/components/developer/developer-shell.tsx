"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DeveloperSidebar } from "@/components/developer/developer-sidebar";
import {
  DEVELOPER_NAV,
  activeDeveloperNavItem,
} from "@/components/developer/developer-nav";
import {
  ConsoleChromeProvider,
  ConsoleThemeToggle,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import { ShellModeProvider } from "@/components/shared/shell-mode-provider";
import type { ConsolePrefs } from "@/lib/console-theme.server";
import { cn } from "@/lib/utils/cn";

/**
 * The Developer panel's chrome: the console palette, a rail on a desk and a
 * strip of links on anything narrower. Web only, like the admin console.
 *
 * `ShellModeProvider` is pinned to the web shell because the observability
 * screens it hosts were written against that context (their "open this at a
 * desk" notice reads it). Locked, it ignores the viewport and any stored
 * preference, so it can never answer "phone".
 */
export function DeveloperShell({
  children,
  name,
  email,
  prefs,
}: {
  children: React.ReactNode;
  name: string;
  email: string | null;
  prefs: ConsolePrefs;
}) {
  return (
    <ShellModeProvider portal="admin" initialMode="web" locked="web">
      <ConsoleChromeProvider initialTheme={prefs.theme} initialRail={prefs.rail}>
        <DeveloperShellChrome name={name} email={email}>
          {children}
        </DeveloperShellChrome>
      </ConsoleChromeProvider>
    </ShellModeProvider>
  );
}

function DeveloperShellChrome({
  children,
  name,
  email,
}: {
  children: React.ReactNode;
  name: string;
  email: string | null;
}) {
  const { theme } = useConsoleChrome();
  const pathname = usePathname();
  const current = activeDeveloperNavItem(pathname);

  return (
    <div
      className="console-theme dashboard-shell admin-shell"
      data-console={theme}
    >
      <DeveloperSidebar name={name} email={email} />
      <div className="admin-content">
        <header className="sticky top-0 z-20 border-b border-line bg-[var(--c-top-bg,var(--surface))]">
          <div className="flex h-[52px] items-center gap-3 px-4 lg:px-6">
            <p className="shrink-0 text-[14px] font-bold tracking-[-0.01em]">
              {current?.label ?? "Developer panel"}
            </p>
            {/* On a narrow screen the rail is hidden, so the destinations sit
                here instead. */}
            <nav
              className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:hidden"
              aria-label="Developer navigation"
            >
              {DEVELOPER_NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current?.href === item.href ? "page" : undefined}
                  className={cn(
                    "press shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold",
                    current?.href === item.href
                      ? "bg-accent/15 text-accent"
                      : "text-muted"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ConsoleThemeToggle />
            </div>
          </div>
        </header>
        <main className="admin-main @container">{children}</main>
      </div>
    </div>
  );
}
