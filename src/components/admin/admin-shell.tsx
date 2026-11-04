"use client";

import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AdminTopBar } from "@/components/admin/admin-top-bar";
import { FoodUploadDock } from "@/components/admin/food-upload-dock";
import { ShellModeProvider } from "@/components/shared/shell-mode-provider";
import {
  ConsoleChromeProvider,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import type { AdminNavCounts } from "@/lib/data-access/admin-stats";
import type { ConsolePrefs } from "@/lib/console-theme.server";
import type { FeatureKey } from "@/lib/features/catalog";

/**
 * Admin chrome: the desktop console only (sidebar + top bar). There is no phone
 * layout, no nav drawer and no layout switch. A phone is sent to `/desktop-only`
 * by the proxy, and a narrow window is covered by `DesktopOnlyGate`. Do not add a
 * small-screen layout to any admin screen (AGENTS.md).
 *
 * The shell mode is locked to `"web"` in `ShellModeProvider`, so anything shared
 * with another portal that asks which shell it is in always hears "web".
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
  /** Admin-console screens switched off in Feature access; their nav goes. */
  featuresOff: FeatureKey[];
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
  featuresOff,
  name,
  email,
}: Readonly<Omit<AdminShellProps, "prefs">>) {
  const { theme } = useConsoleChrome();

  return (
    <>
      <div
        className="console-theme dashboard-shell admin-shell"
        data-console={theme}
      >
        <AdminSidebar
          counts={counts}
          featuresOff={featuresOff}
          name={name}
          email={email}
        />
        <div className="admin-content">
          <AdminTopBar counts={counts} featuresOff={featuresOff} />
          <main className="admin-main @container">{children}</main>
        </div>
      </div>
      {/* Carries `console-theme` itself: it sits outside the shell div that
          would otherwise hand it the console palette — and so it needs the
          palette's *variant* handed to it as well. */}
      <FoodUploadDock className="console-theme" data-console={theme} />
    </>
  );
}
