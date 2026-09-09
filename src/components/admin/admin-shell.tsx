"use client";

import { useCallback, useState } from "react";
import { StatusBar } from "@/components/layout/status-bar";
import { AdminHeader } from "@/components/admin/admin-header";
import { AdminTabBar } from "@/components/admin/admin-tab-bar";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AdminNavDrawer } from "@/components/admin/admin-nav-drawer";
import { AdminTopBar } from "@/components/admin/admin-top-bar";
import { FoodUploadDock } from "@/components/admin/food-upload-dock";
import { DesktopShellSwitcher } from "@/components/shared/desktop-shell-switcher";
import { ShellModeProvider, useShellModeState } from "@/components/shared/shell-mode-provider";
import {
  ConsoleChromeProvider,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import type { AdminNavCounts } from "@/lib/data-access/admin-stats";
import type { ConsoleHealth } from "@/lib/console-health";
import type { ConsolePrefs } from "@/lib/console-theme.server";
import type { ShellMode } from "@/lib/shell-mode";

/**
 * Admin chrome with an app ↔ web switch (desktop/laptop only).
 *
 * - web (default on a computer): sidebar + top bar console
 * - app: the phone frame, for checking how the portal reads on a handset
 *
 * On a real phone the switcher is hidden and the phone shell is forced, so the
 * console layout is never something a handset has to cope with.
 *
 * `initialMode` is resolved **on the server** (`lib/shell-mode.server.ts`) and
 * is what this renders for the hydration pass, so the console is the console in
 * the very first byte of HTML. Before that it was decided client-side only,
 * which meant SSR always answered "app" and every console page shipped as a
 * 402px iPhone mock that swapped to the console a paint later.
 *
 * Both branches wrap page content in `@container`. Pages therefore size
 * themselves against *the column they are in*, not the browser window — the
 * same table can be a real grid in the console and stacked cards inside the
 * 390px phone frame, on one desktop viewport where a `md:` breakpoint would
 * wrongly report "wide" for both.
 *
 * `console-theme` is on the web branch only. It carries the ops-console
 * palette (see globals.css), so the phone frame keeps the app's own look —
 * which is the honest thing for a preview of a handset to do. Alongside it
 * goes `data-console`, the console's own dark/light choice: also resolved on
 * the server (`lib/console-theme.server.ts`), and deliberately independent of
 * the app-wide `data-theme`, which belongs to the customer PWA and is light by
 * default. Anything that carries `console-theme` must carry the attribute too,
 * including the two overlays rendered outside the shell div — otherwise they
 * render dark-by-default while the console around them is light.
 */
interface AdminShellProps {
  children: React.ReactNode;
  counts: AdminNavCounts;
  health: ConsoleHealth;
  name: string;
  email: string | null;
  /** Resolved server-side, per request. See `resolveShellMode`. */
  initialMode: ShellMode;
  /** Palette and rail width, resolved server-side. See `resolveConsolePrefs`. */
  prefs: ConsolePrefs;
}

export function AdminShell({ initialMode, prefs, ...props }: AdminShellProps) {
  return (
    <ShellModeProvider portal="admin" initialMode={initialMode}>
      <ConsoleChromeProvider
        initialTheme={prefs.theme}
        initialRail={prefs.rail}
      >
        <AdminShellChrome {...props} />
      </ConsoleChromeProvider>
    </ShellModeProvider>
  );
}

function AdminShellChrome({
  children,
  counts,
  health,
  name,
  email,
}: Omit<AdminShellProps, "initialMode" | "prefs">) {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const { theme } = useConsoleChrome();

  // Phones never get the console — the switcher is desktop-only. Page tools
  // read the same context, so a screen can never disagree with its own chrome.
  const {
    mode: effective,
    preference,
    setPreference: setMode,
    hydrated,
  } = useShellModeState();

  if (effective === "app") {
    return (
      <>
        <div className="device">
          <div className="app-shell">
            <div className="app-scroll no-scrollbar pb-[80px]">
              <AdminHeader />
              {/* Same vertical rhythm as `.admin-main` in the console, so a
                  screen that returns a list of sections rather than one
                  wrapper div is spaced in both shells. */}
              <div className="@container flex flex-col gap-5 px-4 pb-6 pt-4">
                {children}
              </div>
            </div>
            <StatusBar />
            <AdminTabBar />
          </div>
        </div>
        <DesktopShellSwitcher
          mode={preference}
          onChange={setMode}
          hydrated={hydrated}
        />
        {/* Outside `.device`: a folder upload started on the food photos page
            keeps running wherever the operator goes next, so its progress
            belongs to the console, not to the screen that began it.
            Pinned to the LEFT on desktop widths, not the dock's own default
            right side — `DesktopShellSwitcher` a few lines up is also fixed,
            viewport-level, and anchored bottom-right, so the two would
            otherwise land in the same corner. */}
        <FoodUploadDock className="sm:left-4 sm:right-auto" />
      </>
    );
  }

  return (
    <>
      <div
        className="console-theme dashboard-shell admin-shell"
        data-console={theme}
      >
        <AdminSidebar
          counts={counts}
          health={health}
          name={name}
          email={email}
        />
        <div className="admin-content">
          {/* The layout switch lives in this header. The floating pill is kept
              only for the phone-frame branch above, which has no console header
              to host it — putting it inside the fake handset would read as part
              of the app being previewed. */}
          <AdminTopBar
            counts={counts}
            health={health}
            onMenu={() => setNavOpen(true)}
            shellMode={preference}
            onShellModeChange={setMode}
            shellHydrated={hydrated}
          />
          <main className="admin-main @container">{children}</main>
        </div>
      </div>
      <AdminNavDrawer
        open={navOpen}
        onClose={closeNav}
        counts={counts}
        theme={theme}
      />
      {/* Carries `console-theme` itself: it sits outside the shell div that
          would otherwise hand it the console palette — and so it needs the
          palette's *variant* handed to it as well. */}
      <FoodUploadDock className="console-theme" data-console={theme} />
    </>
  );
}
