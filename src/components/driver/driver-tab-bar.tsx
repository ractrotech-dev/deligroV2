"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DRIVER_TABS } from "@/components/driver/driver-nav";
import { cn } from "@/lib/utils/cn";

/**
 * Bottom nav for the courier phone shell.
 *
 * Same `tab-bar-shell` chrome and the same active treatment as the customer and
 * vendor bars — a rider who has used the customer app should not have to learn
 * a second set of affordances. Three slots rather than five, so each is wider;
 * this is pressed one-handed, often while holding a bag.
 */
const COLORS = {
  green: { text: "text-green", chip: "bg-green/15", bar: "bg-green" },
  blue: { text: "text-blue", chip: "bg-blue/15", bar: "bg-blue" },
  accent: { text: "text-accent", chip: "bg-accent/15", bar: "bg-accent" },
} as const;

export function DriverTabBar() {
  const pathname = usePathname();

  return (
    <nav
      className="tab-bar-shell absolute inset-x-0 bottom-0 z-30 flex items-stretch justify-around px-1 pb-[env(safe-area-inset-bottom)]"
      aria-label="Courier"
    >
      {DRIVER_TABS.map((tab) => {
        const active = tab.match(pathname);
        const color = COLORS[tab.tone];
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "press relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors",
              active ? cn("font-bold", color.text) : "font-medium text-muted"
            )}
          >
            {active ? (
              <span
                className={cn(
                  "absolute inset-x-3 top-0 h-0.5 rounded-full",
                  color.bar
                )}
              />
            ) : null}
            <span
              className={cn(
                "grid size-9 place-items-center rounded-xl transition-colors",
                active ? color.chip : ""
              )}
            >
              <Icon
                className={cn("size-5 transition-colors", color.text)}
                strokeWidth={active ? 2.4 : 2}
              />
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
