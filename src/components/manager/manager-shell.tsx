"use client";

import Link from "next/link";
import { StatusBar } from "@/components/layout/status-bar";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import {
  DesktopShellSwitcher,
  ShellModeToggle,
} from "@/components/shared/desktop-shell-switcher";
import {
  ShellModeProvider,
  useShellModeState,
} from "@/components/shared/shell-mode-provider";
import type { ShellMode } from "@/lib/shell-mode";

/**
 * Manager chrome, with the same app ↔ web switch admin and vendor have.
 *
 * The manager portal is two screens — the live cross-vendor board and the
 * phone-order form — so it gets the shell treatment without the console
 * furniture: no rail, no drawer, no nav model. Fifteen destinations earn a
 * sidebar; two do not.
 *
 * It used to be `.device` unconditionally, which meant an ops desk running the
 * board all shift watched it through a 402px iPhone mock, and an admin (the
 * layout admits them) had no way out of it. Taking a phone order is desk work
 * by definition — a headset and a keyboard — so the web layout is not a
 * courtesy here, it is the one the job is actually done in.
 *
 * Web reuses `.dashboard-shell` / `.dashboard-main`, the responsive column
 * globals.css already defines and `/portals` already uses. Nothing new was
 * introduced to hold it.
 */
export function ManagerShell({
  initialMode,
  children,
}: Readonly<{
  initialMode: ShellMode;
  children: React.ReactNode;
}>) {
  return (
    <ShellModeProvider portal="manager" initialMode={initialMode}>
      <ManagerShellChrome>{children}</ManagerShellChrome>
    </ShellModeProvider>
  );
}

function ManagerShellChrome({ children }: Readonly<{ children: React.ReactNode }>) {
  const { mode, preference, setPreference, hydrated } = useShellModeState();

  if (mode === "app") {
    return (
      <>
        <div className="device">
          <div className="app-shell">
            <div className="app-scroll no-scrollbar @container px-4 pb-6 pt-4">
              <main>{children}</main>
            </div>
            <StatusBar />
          </div>
        </div>
        <DesktopShellSwitcher
          mode={preference}
          onChange={setPreference}
          hydrated={hydrated}
        />
      </>
    );
  }

  return (
    <div className="console-theme dashboard-shell">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1120px] items-center justify-between gap-3 px-4 py-3 md:px-7">
          <Link href="/manager" className="min-w-0">
            <p className="text-[15px] font-bold leading-tight text-ink">
              Deligro Operations
            </p>
            <p className="truncate text-xs text-muted">
              Every order in flight, across every restaurant
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <ShellModeToggle
              mode={preference}
              onChange={setPreference}
              hydrated={hydrated}
            />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="dashboard-main @container">{children}</main>
    </div>
  );
}
