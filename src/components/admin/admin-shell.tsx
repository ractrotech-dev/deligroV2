"use client";

import { useCallback, useState } from "react";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AdminNavDrawer } from "@/components/admin/admin-nav-drawer";
import { AdminTopBar } from "@/components/admin/admin-top-bar";
import { FoodUploadDock } from "@/components/admin/food-upload-dock";
import { ShellModeProvider } from "@/components/shared/shell-mode-provider";
import {
  ConsoleChromeProvider,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import type { AdminNavCounts } from "@/lib/data-access/admin-stats";
import type { ConsolePrefs } from "@/lib/console-theme.server";

/**
 * Admin chrome: the web console only (sidebar + top bar). There is no phone
 * frame and no layout switch; Admin is website-only (see `mobile/README.md`).
 *
 * The shell mode is locked to `"web"` in `ShellModeProvider`, so anything that
 * asks which shell it is in (`ConsoleOnly`, `useAdminShellMode`) always hears
 * "web", on every screen size and on the server render too.
 *
 * Page content is wrapped in `@container` so pages size themselves against
 * *the column they are in*, not the browser window.
 *
 * `console-theme` carries the ops-console palette (see globals.css), alongside
 * `data-console`, the console's own dark/light choice: resolved on the server
 * (`lib/console-theme.server.ts`), and deliberately independent of the
 * app-wide `data-theme`, which belongs to the customer PWA and is light by
 * default. Anything that carries `console-theme` must carry the attribute too,
 * including the overlays rendered outside the shell div; otherwise they render
 * dark-by-default while the console around them is light.
 */
interface AdminShellProps {
  children: React.ReactNode;
  counts: AdminNavCounts;
  name: string;
  email: string | null;
  /** Palette and rail width, resolved server-side. See `resolveConsolePrefs`. */
  prefs: ConsolePrefs;
}

export function AdminShell({ prefs, ...props }: Readonly<AdminShellProps>) {
  return (
    <ShellModeProvider portal="admin" initialMode="web" locked="web">
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
  name,
  email,
}: Readonly<Omit<AdminShellProps, "prefs">>) {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const { theme } = useConsoleChrome();

  return (
    <>
      <div
        className="console-theme dashboard-shell admin-shell"
        data-console={theme}
      >
        <AdminSidebar
          counts={counts}
          name={name}
          email={email}
        />
        <div className="admin-content">
          <AdminTopBar
            counts={counts}
            onMenu={() => setNavOpen(true)}
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
