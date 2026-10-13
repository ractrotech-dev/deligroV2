import { Activity, LayoutDashboard, ToggleRight } from "lucide-react";

/**
 * The Developer panel's navigation: everything that keeps the app itself
 * working, kept out of the admin console, which is the company's operations.
 *
 * Presentation only. Every destination's own layout calls
 * `requireRole("developer")`, and the data layers behind them check it again;
 * hiding or showing an entry here grants nothing.
 */
export interface DeveloperNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  group: (typeof DEVELOPER_NAV_GROUPS)[number];
  match: (pathname: string) => boolean;
}

export const DEVELOPER_NAV_GROUPS = ["Health", "Monitoring", "Configuration"] as const;

export const DEVELOPER_NAV: DeveloperNavItem[] = [
  {
    href: "/developer",
    label: "Overview",
    icon: LayoutDashboard,
    group: "Health",
    match: (p) => p === "/developer",
  },
  {
    href: "/developer/observability",
    label: "Observability",
    icon: Activity,
    group: "Monitoring",
    match: (p) => p.startsWith("/developer/observability"),
  },
  {
    // What each category of user can use, switched on or off.
    href: "/developer/features",
    label: "Feature access",
    icon: ToggleRight,
    group: "Configuration",
    match: (p) => p.startsWith("/developer/features"),
  },
];

/** The longest matching entry wins, so /developer does not claim its children. */
export function activeDeveloperNavItem(
  pathname: string
): DeveloperNavItem | null {
  const hits = DEVELOPER_NAV.filter((i) => i.match(pathname));
  if (!hits.length) return null;
  return hits.reduce((best, i) => (i.href.length > best.href.length ? i : best));
}
