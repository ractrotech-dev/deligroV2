import { Bike, ClipboardList, User } from "lucide-react";

/**
 * The courier app's three screens.
 *
 * Smaller than `vendor-nav.ts` on purpose, and shaped differently: there is no
 * `group` and no `primary` flag because there is no rail to group for and no
 * overflow to demote. A rider has one phone shell and three tabs, all of which
 * fit — the vendor's five-slot squeeze does not exist here.
 *
 * Jobs is first and stays first. It is the screen a rider is holding when they
 * are working; the other two are things they open between deliveries, and
 * neither should ever be what the app opens on.
 */
export interface DriverNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: "green" | "blue" | "accent";
  match: (pathname: string) => boolean;
}

export const DRIVER_TABS: DriverNavItem[] = [
  {
    href: "/driver",
    label: "Jobs",
    icon: Bike,
    tone: "accent",
    // Exact, not `startsWith`: every other tab is nested under /driver, so a
    // prefix match would light this one up on all three screens.
    match: (p) => p === "/driver",
  },
  {
    href: "/driver/history",
    label: "History",
    icon: ClipboardList,
    tone: "blue",
    match: (p) => p.startsWith("/driver/history"),
  },
  {
    href: "/driver/profile",
    label: "Profile",
    icon: User,
    tone: "green",
    match: (p) => p.startsWith("/driver/profile"),
  },
];
