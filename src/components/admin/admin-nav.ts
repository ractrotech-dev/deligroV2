import {
  MessageSquareText,
  Banknote,
  BellRing,
  Bike,
  FileSpreadsheet,
  HandCoins,
  Images,
  LayoutDashboard,
  LifeBuoy,
  ListOrdered,
  MapPinned,
  Megaphone,
  ReceiptText,
  Settings,
  SlidersHorizontal,
  Store,
  TicketPercent,
  ToggleRight,
  UserCog,
  Users,
  Wallet,
  ScrollText,
  Siren,
} from "lucide-react";
import type { FeatureKey } from "@/lib/features/catalog";

/**
 * One nav definition for the admin console's left rail. Team and Platform
 * configuration are settings *sub*-pages that the rail lists directly, because
 * creating a staff login is a daily job.
 */
export type BadgeKey = "liveOrders";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Which sidebar group it sits under. */
  group: "Overview" | "Operations" | "Catalogue" | "People" | "System";
  /**
   * The Feature access switch (`admin.*`) that turns this screen off. Off drops
   * the entry everywhere it is listed, and the route renders a notice.
   */
  feature?: FeatureKey;
  /** Live count rendered as a pill. */
  badge?: BadgeKey;
  /** Colour used by the sidebar's active state. */
  tone: "green" | "blue" | "accent" | "deal" | "violet" | "pop";
  match: (pathname: string) => boolean;
}

export const ADMIN_NAV: AdminNavItem[] = [
  {
    href: "/admin",
    label: "Dashboard",
    icon: LayoutDashboard,
    group: "Overview",
    tone: "green",
    match: (p) => p === "/admin",
  },
  {
    href: "/admin/orders",
    label: "Orders",
    icon: ReceiptText,
    group: "Operations",
    badge: "liveOrders",
    tone: "blue",
    match: (p) => p.startsWith("/admin/orders"),
  },
  {
    href: "/admin/settlements",
    label: "Settlements",
    icon: Banknote,
    group: "Operations",
    tone: "green",
    match: (p) => p.startsWith("/admin/settlements"),
  },
  {
    // A sub-route of Settlements listed directly on the rail, like Featured
    // slots under Vendors: paying a single order early is a daily job, and
    // activeNavItem's longest-href rule keeps Settlements highlighted elsewhere.
    href: "/admin/settlements/orders",
    label: "Pay a shop",
    icon: HandCoins,
    group: "Operations",
    tone: "pop",
    match: (p) => p.startsWith("/admin/settlements/orders"),
  },
  {
    href: "/admin/reports",
    label: "Reports",
    icon: FileSpreadsheet,
    group: "Operations",
    tone: "violet",
    match: (p) => p.startsWith("/admin/reports"),
  },
  {
    href: "/admin/cash-ledger",
    label: "Cash & expenses",
    icon: Wallet,
    group: "Operations",
    tone: "accent",
    match: (p) => p.startsWith("/admin/cash-ledger"),
  },
  {
    // Riders' (and shops') tickets and incidents; emergencies pinned on top.
    // Same entry as the Partner branch's, so the two merge as one.
    href: "/admin/support",
    label: "Support",
    icon: LifeBuoy,
    group: "Operations",
    tone: "blue",
    match: (p) => p.startsWith("/admin/support"),
  },
  {
    // Operational alerts (Phase 8): critical first, raised and cleared by the engine.
    href: "/admin/alerts",
    label: "Alerts",
    icon: Siren,
    group: "Operations",
    tone: "pop",
    match: (p) => p.startsWith("/admin/alerts") || p.startsWith("/admin/settings/alerts"),
  },
  {
    href: "/admin/marketing",
    label: "Marketing requests",
    icon: Megaphone,
    group: "Operations",
    tone: "pop",
    match: (p) => p.startsWith("/admin/marketing"),
  },
  {
    href: "/admin/announcements",
    label: "Announcements",
    icon: BellRing,
    group: "Operations",
    tone: "violet",
    match: (p) => p.startsWith("/admin/announcements"),
  },
  {
    href: "/admin/vendors",
    label: "Vendors",
    icon: Store,
    group: "Catalogue",
    tone: "accent",
    match: (p) => p.startsWith("/admin/vendors"),
  },
  {
    // A sub-route of Vendors that the rail lists directly, for the same reason
    // Team and Platform config are listed: activeNavItem's longest-href rule
    // hands it the highlight here, and Vendors keeps it everywhere else.
    href: "/admin/vendors/slots",
    label: "Featured slots",
    icon: ListOrdered,
    group: "Catalogue",
    tone: "deal",
    match: (p) => p.startsWith("/admin/vendors/slots"),
  },
  {
    href: "/admin/storage",
    label: "Storage",
    icon: Images,
    group: "Catalogue",
    tone: "green",
    match: (p) => p.startsWith("/admin/storage"),
  },
  {
    href: "/admin/banners",
    label: "Campaigns",
    icon: Megaphone,
    group: "Catalogue",
    tone: "pop",
    match: (p) => p.startsWith("/admin/banners"),
  },
  {
    href: "/admin/coupons",
    label: "Promo codes",
    icon: TicketPercent,
    group: "Catalogue",
    tone: "deal",
    match: (p) => p.startsWith("/admin/coupons"),
  },
  {
    href: "/admin/customers",
    label: "Customers",
    icon: Users,
    group: "People",
    tone: "green",
    match: (p) => p.startsWith("/admin/customers"),
  },
  {
    href: "/admin/riders",
    label: "Riders",
    icon: Bike,
    group: "People",
    tone: "pop",
    match: (p) => p.startsWith("/admin/riders"),
  },
  {
    href: "/admin/settings/employees",
    label: "Team",
    icon: UserCog,
    group: "People",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/employees"),
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    icon: ScrollText,
    group: "System",
    tone: "blue",
    match: (p) => p.startsWith("/admin/audit"),
  },
  {
    href: "/admin/settings/zones",
    label: "Zones",
    icon: MapPinned,
    group: "System",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/zones"),
  },
  {
    href: "/admin/settings/feature-access",
    label: "Feature access",
    icon: ToggleRight,
    group: "People",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/feature-access"),
  },
  {
    href: "/admin/settings/sms",
    label: "Vendor SMS",
    icon: MessageSquareText,
    group: "System",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/sms"),
  },
  {
    href: "/admin/settings/platform",
    label: "Platform config",
    icon: SlidersHorizontal,
    group: "System",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/platform"),
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: Settings,
    group: "System",
    tone: "violet",
    // Deliberately broad: it also covers sub-pages with no rail entry of their
    // own. Where a sub-page *does* have one, activeNavItem's longest-href rule
    // hands the highlight to that entry instead — which is why consumers must
    // resolve the active item through it, not by calling match() per item.
    // Settings → Alert thresholds belongs to Alerts, and "/admin/settings" is the
    // longer href, so it has to step aside here or it would win the highlight.
    match: (p) => p.startsWith("/admin/settings") && !p.startsWith("/admin/settings/alerts"),
  },
];

export const ADMIN_NAV_GROUPS = [
  "Overview",
  "Operations",
  "Catalogue",
  "People",
  "System",
] as const;

/** The entries still on: drops every screen whose `feature` is switched off. */
export function enabledNav<T extends AdminNavItem>(
  items: readonly T[],
  featuresOff: readonly FeatureKey[]
): T[] {
  return items.filter((i) => !i.feature || !featuresOff.includes(i.feature));
}

/** Longest matching route wins, so /admin doesn't claim /admin/orders. */
export function activeNavItem(pathname: string): AdminNavItem | null {
  const hits = ADMIN_NAV.filter((i) => i.match(pathname));
  if (!hits.length) return null;
  return hits.reduce(
    (best, i) => (i.href.length > best.href.length ? i : best),
    hits[0]
  );
}
