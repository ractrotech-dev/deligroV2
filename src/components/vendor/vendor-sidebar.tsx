"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import {
  RailToggle,
  useConsoleChrome,
} from "@/components/admin/console/chrome";
import {
  VENDOR_NAV,
  VENDOR_NAV_GROUPS,
  activeVendorNavItem,
} from "@/components/vendor/vendor-nav";
import { RestaurantSwitcher } from "@/components/vendor/restaurant-switcher";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { initials } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { OwnedRestaurant } from "@/lib/data-access/vendor-restaurant";

/**
 * The partner hub's left rail — the same rail as the admin console, because it
 * is the same product to the same owner. Grouped nav, a store-status card, and
 * the account row at the foot so the rail is not empty on a seven-item list.
 *
 * Collapses to a 56px icon column, from the cookie the layout resolves. In
 * compact mode the store card goes and its state survives as the dot on the
 * account row: a paused store is the one thing a vendor must never be able to
 * miss, and it is the reason this rail carries a status at all.
 */
export function VendorSidebar({
  restaurantName,
  isOpen,
  restaurants = [],
  activeSlug = "",
  showControls,
  name,
  email,
}: {
  restaurantName: string;
  isOpen: boolean;
  restaurants?: OwnedRestaurant[];
  activeSlug?: string;
  showControls: boolean;
  name: string;
  email: string | null;
}) {
  const pathname = usePathname();
  const current = activeVendorNavItem(pathname);
  const multiStore = restaurants.length > 1;
  const { rail } = useConsoleChrome();
  const compact = rail === "compact";

  return (
    <aside className="vendor-sidebar hidden lg:flex">
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
            href="/vendor"
            className="press flex min-w-0 items-center gap-[9px]"
            aria-label="Deligro partner hub"
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
                  Partner hub
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
          aria-label="Vendor navigation"
        >
          {VENDOR_NAV_GROUPS.map((group, groupIndex) => {
            const items = VENDOR_NAV.filter((i) => i.group === group);
            if (!items.length) return null;
            return (
              <div key={group}>
                {compact ? (
                  // The heading, as a rule — a 56px column cannot carry
                  // "Catalogue", and dropping the grouping entirely would leave
                  // one undifferentiated stack of icons.
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
                      <Link
                        href={item.href}
                        aria-current={
                          current?.href === item.href ? "page" : undefined
                        }
                        // The label is the accessible name in both widths.
                        // Without this a collapsed rail is seven links called
                        // nothing.
                        aria-label={compact ? item.label : undefined}
                        title={compact ? item.label : undefined}
                        className={cn(
                          "relative flex items-center rounded-[7px] text-[12.5px] transition-colors duration-[120ms]",
                          compact
                            ? "h-9 justify-center"
                            : "gap-[9px] px-[9px] py-[7px]",
                          current?.href === item.href
                            ? "bg-[var(--sb-active)] font-semibold text-[var(--sb-text-active)]"
                            : "font-medium text-[var(--sb-text)] hover:bg-[var(--sb-hover)] hover:text-white"
                        )}
                      >
                        {current?.href === item.href ? (
                          <span
                            aria-hidden
                            className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent"
                          />
                        ) : null}
                        <item.icon
                          className="size-[16px] shrink-0"
                          strokeWidth={1.7}
                        />
                        {compact ? null : (
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                        )}
                      </Link>
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
          {compact ? null : (
          <StoreCard
            restaurantName={restaurantName}
            isOpen={isOpen}
            showControls={showControls}
            restaurants={restaurants}
            activeSlug={activeSlug}
            multiStore={multiStore}
          />
          )}

          <div
            className={cn(
              "flex items-center gap-2.5",
              compact && "flex-col gap-1.5"
            )}
          >
            <span
              className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[11px] font-bold text-[var(--on-accent)]"
              title={email ? `${name} · ${email}` : name}
            >
              {initials(name)}
              {compact ? (
                // The store's state, surviving the collapse. A paused store is
                // the one thing this rail exists to keep in front of a vendor.
                <span
                  aria-hidden
                  className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--sb-bg)]"
                  style={{
                    background: isOpen ? "var(--sb-ok)" : "#ffa060",
                  }}
                />
              ) : null}
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

          {!compact && isSupabaseConfigured ? (
            <form action="/auth/signout?next=/vendor/login" method="post">
              <button
                type="submit"
                className="press flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-xs font-semibold text-[var(--sb-meta)] transition-colors hover:bg-[var(--sb-hover)] hover:text-white"
              >
                <LogOut className="size-[15px]" strokeWidth={1.7} />
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function StoreCard({
  restaurantName,
  isOpen,
  showControls,
  restaurants,
  activeSlug,
  multiStore,
}: {
  restaurantName: string;
  isOpen: boolean;
  showControls: boolean;
  restaurants: OwnedRestaurant[];
  activeSlug: string;
  multiStore: boolean;
}) {
  return (
    <div className="rounded-[9px] border border-[var(--sb-border)] px-[11px] py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--sb-group)]">
          Store
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-[11px] font-semibold",
            isOpen ? "text-[var(--sb-ok)]" : "text-[#ffa060]"
          )}
        >
          <span
            className="c-dot"
            style={{
              background: isOpen ? "var(--sb-ok)" : "#ffa060",
            }}
          />
          {isOpen ? "Open" : "Paused"}
        </span>
      </div>
      {showControls && multiStore && activeSlug ? (
        <div className="mt-2">
          <RestaurantSwitcher
            restaurants={restaurants}
            activeSlug={activeSlug}
            fullWidth
            className="w-full rounded-md border border-[var(--sb-border)] bg-transparent px-2 py-1.5 text-[12px] font-medium text-white outline-none"
          />
        </div>
      ) : (
        <p className="mt-2 truncate text-[12px] font-semibold text-[#e8e6e1]">
          {restaurantName}
        </p>
      )}
    </div>
  );
}
