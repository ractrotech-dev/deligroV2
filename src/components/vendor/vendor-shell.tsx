"use client";

import { useCallback, useState } from "react";
import { StatusBar } from "@/components/layout/status-bar";
import { VendorHeader } from "@/components/vendor/vendor-header";
import { VendorTabBar } from "@/components/vendor/vendor-tab-bar";
import { VendorSidebar } from "@/components/vendor/vendor-sidebar";
import { VendorNavDrawer } from "@/components/vendor/vendor-nav-drawer";
import { VendorTopBar } from "@/components/vendor/vendor-top-bar";
import { DesktopShellSwitcher } from "@/components/shared/desktop-shell-switcher";
import { ShellModeProvider, useShellModeState } from "@/components/shared/shell-mode-provider";
import {
  ConsoleChromeProvider,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import type { OwnedRestaurant } from "@/lib/data-access/vendor-restaurant";
import type { ConsolePrefs } from "@/lib/console-theme.server";
import type { ShellMode } from "@/lib/shell-mode";

export type VendorShellProps = {
  restaurantName: string;
  isOpen: boolean;
  restaurants: OwnedRestaurant[];
  activeSlug: string;
  showControls: boolean;
  name: string;
  email: string | null;
  /** Resolved server-side, per request. See `resolveShellMode`. */
  initialMode: ShellMode;
  /** Palette and rail width, resolved server-side. See `resolveConsolePrefs`. */
  prefs: ConsolePrefs;
  children: React.ReactNode;
};

/**
 * Vendor chrome with an app ↔ web switch (desktop/laptop only).
 *
 * - web (default on a computer): sidebar + top bar console, same structure as
 *   the admin ops console
 * - app: the phone frame, for checking how the portal reads on a handset
 *
 * On a real phone the switcher is hidden and the phone shell is forced.
 *
 * `initialMode` is resolved server-side (`lib/shell-mode.server.ts`), so the
 * console is the console in the first byte of HTML rather than after hydration.
 * Both branches wrap page content in `@container` so pages size themselves
 * against the column they are in, not the browser window.
 *
 * `console-theme` is on the web branch only, so the phone frame keeps the
 * app's own look. `data-console` beside it is the console's own dark/light
 * choice — see `lib/console-theme.ts` for why that is not the app-wide
 * `data-theme`. Admin and vendor share one preference deliberately: it is a
 * property of the console, and an owner who runs both should not have to set
 * it twice.
 */
export function VendorShell({
  initialMode,
  prefs,
  ...props
}: VendorShellProps) {
  return (
    <ShellModeProvider portal="vendor" initialMode={initialMode}>
      <ConsoleChromeProvider
        initialTheme={prefs.theme}
        initialRail={prefs.rail}
      >
        <VendorShellChrome {...props} />
      </ConsoleChromeProvider>
    </ShellModeProvider>
  );
}

function VendorShellChrome({
  children,
  restaurantName,
  isOpen,
  restaurants,
  activeSlug,
  showControls,
  name,
  email,
}: Omit<VendorShellProps, "initialMode" | "prefs">) {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  const {
    mode: effective,
    preference,
    setPreference: setMode,
    hydrated,
  } = useShellModeState();
  const { theme } = useConsoleChrome();

  const shellProps = {
    restaurantName,
    isOpen,
    restaurants,
    activeSlug,
    showControls,
  };

  if (effective === "app") {
    return (
      <>
        <div className="device">
          <div className="app-shell">
            <div className="app-scroll no-scrollbar pb-[80px]">
              <VendorHeader
                title={restaurantName}
                subtitle={isOpen ? "Accepting orders" : "Store paused"}
                isOpen={isOpen}
                showControls={showControls}
              />
              <div className="@container flex flex-col gap-5 px-4 pb-6 pt-4">
                {children}
              </div>
            </div>
            <StatusBar />
            <VendorTabBar />
          </div>
        </div>
        <DesktopShellSwitcher
          mode={preference}
          onChange={setMode}
          hydrated={hydrated}
        />
      </>
    );
  }

  return (
    <>
      <div
        className="console-theme dashboard-shell vendor-shell"
        data-console={theme}
      >
        <VendorSidebar {...shellProps} name={name} email={email} />
        <div className="vendor-content">
          <VendorTopBar
            {...shellProps}
            onMenu={() => setNavOpen(true)}
            shellMode={preference}
            onShellModeChange={setMode}
            shellHydrated={hydrated}
          />
          <main className="vendor-main @container">{children}</main>
        </div>
      </div>
      <VendorNavDrawer open={navOpen} onClose={closeNav} theme={theme} />
    </>
  );
}
