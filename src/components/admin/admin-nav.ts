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
  Inbox,
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
  WalletCards,
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
  /** Which sidebar category it sits under. */
  group: AdminNavGroup;
  /**
   * The App features switch (`admin.*`) that turns this screen off. Off drops
   * the entry everywhere it is listed, and the route renders a notice.
   */
  feature?: FeatureKey;
  /** Live count rendered as a pill. */
  badge?: BadgeKey;
  match: (pathname: string) => boolean;
}

export const ADMIN_NAV: AdminNavItem[] = [
  {
    href: "/admin",
    label: "Dashboard",
    icon: LayoutDashboard,
    group: "Overview",
    match: (p) => p === "/admin",
  },
  {
    href: "/admin/orders",
    label: "Orders",
    icon: ReceiptText,
    group: "Orders & support",
    badge: "liveOrders",
    match: (p) => p.startsWith("/admin/orders"),
  },
  {
    // Riders' (and shops') tickets and incidents; emergencies pinned on top.
    // Same entry as the Partner branch's, so the two merge as one.
    href: "/admin/support",
    label: "Support",
    icon: LifeBuoy,
    group: "Orders & support",
    match: (p) => p.startsWith("/admin/support"),
  },
  {
    // Operational alerts (Phase 8): critical first, raised and cleared by the engine.
    href: "/admin/alerts",
    label: "Alerts",
    icon: Siren,
    group: "Orders & support",
    match: (p) => p.startsWith("/admin/alerts") || p.startsWith("/admin/settings/alerts"),
  },
  {
    href: "/admin/settlements",
    label: "Settlements",
    icon: Banknote,
    group: "Money",
    match: (p) => p.startsWith("/admin/settlements"),
  },
  {
    // A sub-route of Settlements listed directly on the rail, like Featured
    // slots under Vendors: paying a single order early is a daily job, and
    // activeNavItem's longest-href rule keeps Settlements highlighted elsewhere.
    href: "/admin/settlements/orders",
    label: "Pay a shop",
    icon: HandCoins,
    group: "Money",
    match: (p) => p.startsWith("/admin/settlements/orders"),
  },
  {
    href: "/admin/cash-ledger",
    label: "Cash & expenses",
    icon: Wallet,
    group: "Money",
    match: (p) => p.startsWith("/admin/cash-ledger"),
  },
  {
    // What Deligro holds for customers as wallet points (0198).
    href: "/admin/customer-wallets",
    label: "Customer wallets",
    icon: WalletCards,
    group: "Money",
    match: (p) => p.startsWith("/admin/customer-wallets"),
  },
  {
    href: "/admin/reports",
    label: "Reports",
    icon: FileSpreadsheet,
    group: "Money",
    match: (p) => p.startsWith("/admin/reports"),
  },
  {
    href: "/admin/vendors",
    label: "Vendors",
    icon: Store,
    group: "Shops",
    match: (p) => p.startsWith("/admin/vendors"),
  },
  {
    // A sub-route of Vendors that the rail lists directly, for the same reason
    // Team and Platform config are listed: activeNavItem's longest-href rule
    // hands it the highlight here, and Vendors keeps it everywhere else.
    href: "/admin/vendors/slots",
    label: "Featured slots",
    icon: ListOrdered,
    group: "Shops",
    match: (p) => p.startsWith("/admin/vendors/slots"),
  },
  {
    href: "/admin/storage",
    label: "Storage",
    icon: Images,
    group: "Shops",
    match: (p) => p.startsWith("/admin/storage"),
  },
  {
    href: "/admin/banners",
    label: "Campaigns & ads",
    icon: Megaphone,
    group: "Marketing",
    match: (p) => p.startsWith("/admin/banners"),
  },
  {
    href: "/admin/coupons",
    label: "Promo codes",
    icon: TicketPercent,
    group: "Marketing",
    match: (p) => p.startsWith("/admin/coupons"),
  },
  {
    href: "/admin/marketing",
    label: "Marketing requests",
    icon: Inbox,
    group: "Marketing",
    match: (p) => p.startsWith("/admin/marketing"),
  },
  {
    href: "/admin/announcements",
    label: "Announcements",
    icon: BellRing,
    group: "Marketing",
    match: (p) => p.startsWith("/admin/announcements"),
  },
  {
    href: "/admin/customers",
    label: "Customers",
    icon: Users,
    group: "People",
    match: (p) => p.startsWith("/admin/customers"),
  },
  {
    href: "/admin/riders",
    label: "Riders",
    icon: Bike,
    group: "People",
    match: (p) => p.startsWith("/admin/riders"),
  },
  {
    href: "/admin/settings/employees",
    label: "Team",
    icon: UserCog,
    group: "People",
    match: (p) => p.startsWith("/admin/settings/employees"),
  },
  {
    href: "/admin/settings/platform",
    label: "Platform config",
    icon: SlidersHorizontal,
    group: "System",
    match: (p) => p.startsWith("/admin/settings/platform"),
  },
  {
    // The URL keeps its old name, so links that exist keep working.
    href: "/admin/settings/zones",
    label: "Delivery radius and zones",
    icon: MapPinned,
    group: "System",
    match: (p) => p.startsWith("/admin/settings/zones"),
  },
  {
    // The URL keeps its old name, so links that exist keep working.
    href: "/admin/settings/feature-access",
    label: "App features",
    icon: ToggleRight,
    group: "System",
    match: (p) => p.startsWith("/admin/settings/feature-access"),
  },
  {
    href: "/admin/settings/sms",
    label: "Vendor SMS",
    icon: MessageSquareText,
    group: "System",
    match: (p) => p.startsWith("/admin/settings/sms"),
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    icon: ScrollText,
    group: "System",
    match: (p) => p.startsWith("/admin/audit"),
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: Settings,
    group: "System",
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
  "Orders & support",
  "Money",
  "Shops",
  "Marketing",
  "People",
  "System",
] as const;

export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];

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
