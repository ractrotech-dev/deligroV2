"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { ConsoleThemeToggle } from "@/components/admin/console/chrome";
import { activeVendorNavItem } from "@/components/vendor/vendor-nav";
import { RestaurantOpenToggle } from "@/components/vendor/restaurant-open-toggle";
import { RestaurantSwitcher } from "@/components/vendor/restaurant-switcher";
import {
  ShellModeToggle,
  type ShellMode,
} from "@/components/shared/desktop-shell-switcher";
import type { OwnedRestaurant } from "@/lib/data-access/vendor-restaurant";

/**
 * The console's top bar: current page, store switcher, live status, and the
 * open/closed control. Account lives on the rail, matching the admin console.
 *
 * The palette and layout switches live here rather than floating over the page,
 * for the same reason they do in the admin bar: they change what you are
 * looking at, so they belong with the other controls that do, and a fixed pill
 * in the bottom-right corner sat on top of the action dock on every form
 * screen.
 */
export function VendorTopBar({
  restaurantName,
  isOpen,
  restaurants,
  activeSlug,
  showControls,
  onMenu,
  shellMode,
  onShellModeChange,
  shellHydrated,
}: {
  restaurantName: string;
  isOpen: boolean;
  restaurants: OwnedRestaurant[];
  activeSlug: string;
  showControls: boolean;
  onMenu: () => void;
  /** Current layout, so the toggle can live in the header rather than float. */
  shellMode: ShellMode;
  onShellModeChange: (mode: ShellMode) => void;
  /** False until the stored preference has loaded; the toggle stays inert. */
  shellHydrated: boolean;
}) {
  const pathname = usePathname();
  const active = activeVendorNavItem(pathname);
  const multiStore = restaurants.length > 1;

  return (
    <header className="vendor-top-bar sticky top-0 z-30 border-b border-line bg-[color:var(--bg)]/92 backdrop-blur-lg">
      {/* Fixed height, matching `--c-top-h` on the shell — a sticky page
          toolbar offsets by that, so the two have to agree. */}
      <div className="flex h-[52px] items-center gap-3 px-4 lg:px-6">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open navigation"
          className="press grid size-8 shrink-0 place-items-center rounded-[var(--c-r)] border border-line bg-surface text-muted lg:hidden"
        >
          <Menu className="size-4" />
        </button>

        <p className="shrink-0 text-[14px] font-bold tracking-[-0.01em] lg:hidden">
          {active?.label ?? "Vendor"}
        </p>

        {showControls && multiStore ? (
          <div className="hidden min-w-0 sm:block lg:ml-0">
            <RestaurantSwitcher
              restaurants={restaurants}
              activeSlug={activeSlug}
            />
          </div>
        ) : (
          <p className="hidden min-w-0 truncate text-[13px] font-medium text-muted lg:block">
            {restaurantName}
          </p>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {isOpen ? (
            <span className="hidden items-center gap-1.5 rounded-[var(--c-r)] border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-medium text-ink sm:inline-flex">
              <span className="c-dot bg-green" />
              Accepting orders
            </span>
          ) : (
            <span className="hidden items-center gap-1.5 rounded-[var(--c-r)] bg-[var(--c-tint-amber)] px-2.5 py-1.5 text-[11.5px] font-semibold text-[color:var(--c-ink-amber)] sm:inline-flex">
              <span className="c-status-dot" />
              Store paused
            </span>
          )}

          {/* Sign-out is the rail's, not this bar's — VendorTopBar only ever
              renders beside VendorSidebar (see VendorShell), and the same
              control in both places was one too many. */}
          {showControls ? <RestaurantOpenToggle isOpen={isOpen} /> : null}

          <span
            aria-hidden
            className="mx-1 hidden h-5 w-px bg-line min-[480px]:block"
          />
          <ConsoleThemeToggle />
          <ShellModeToggle
            mode={shellMode}
            onChange={onShellModeChange}
            hydrated={shellHydrated}
          />
        </div>
      </div>
    </header>
  );
}
