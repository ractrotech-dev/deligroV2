import {
  Activity,
  Banknote,
  FileSpreadsheet,
  HandCoins,
  Images,
  LayoutDashboard,
  ListOrdered,
  Megaphone,
  ReceiptText,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Store,
  TicketPercent,
  ToggleRight,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";

/**
 * One nav definition, three consumers: the web sidebar, the phone bottom tabs,
 * and the top bar's page title. The phone frame can only carry five tabs, so
 * `primary` marks the five that earn a slot there — everything else the phone
 * can use is one tap away inside Settings, and the rail lists all of it.
 *
 * The five tabs are chosen for what an operator does *away from a desk*:
 * Dashboard, Orders, Refunds, Vendors, Settings. Campaigns is a rail item
 * rather than a tab because both of its authoring routes are console-only —
 * spending a fifth of the phone's navigation on "pause a banner" is a poor
 * trade against Refunds, which is a pure decision queue and carries a badge.
 *
 * Team and Platform configuration are settings *sub*-pages that the rail lists
 * directly: the console has the room, and burying a daily job like creating a
 * staff login two taps deep is only a phone compromise. The Settings menu drops
 * those rows in web mode (see admin/settings/page.tsx) so the rail is the one
 * place they appear there.
 *
 * `reach: "console"` marks the rail entries a phone should never be offered at
 * all, because the screen behind them is console-only. They stay in the rail
 * and keep their page title; they just don't appear in the phone's Settings
 * menu, where tapping through would only find a notice.
 *
 * It is a **route contract, not a nav filter** (AGENTS.md). Setting it here
 * obliges the route itself to render `<ConsoleOnly variant="page">` — dropping
 * the menu entry alone leaves the URL open, which is how a phone ended up
 * rendering the ten-tab observability console in a 370px column.
 * `npm run test:platform` fails if the two halves disagree.
 */
export type BadgeKey = "pendingApprovals" | "pendingRefunds" | "liveOrders";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Which sidebar group it sits under. */
  group: "Overview" | "Operations" | "Catalogue" | "People" | "System";
  /** Shown on the phone's five-slot bottom bar. */
  primary?: boolean;
  /** Rail and drawer only — never offered as a phone destination. */
  reach?: "console";
  /** Live count rendered as a pill. */
  badge?: BadgeKey;
  /** Colour used by the phone tab bar and the sidebar's active state. */
  tone: "green" | "blue" | "accent" | "deal" | "violet" | "pop";
  match: (pathname: string) => boolean;
}

export const ADMIN_NAV: AdminNavItem[] = [
  {
    href: "/admin",
    label: "Dashboard",
    icon: LayoutDashboard,
    group: "Overview",
    primary: true,
    tone: "green",
    match: (p) => p === "/admin",
  },
  {
    href: "/admin/orders",
    label: "Orders",
    icon: ReceiptText,
    group: "Operations",
    primary: true,
    badge: "liveOrders",
    tone: "blue",
    match: (p) => p.startsWith("/admin/orders"),
  },
  {
    href: "/admin/refunds",
    label: "Refunds",
    icon: RotateCcw,
    group: "Operations",
    primary: true,
    badge: "pendingRefunds",
    tone: "deal",
    match: (p) => p.startsWith("/admin/refunds"),
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
    label: "Order payouts",
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
    href: "/admin/vendors",
    label: "Vendors",
    icon: Store,
    group: "Catalogue",
    primary: true,
    badge: "pendingApprovals",
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
    match: (p) =>
      p.startsWith("/admin/storage") ||
      p.startsWith("/admin/food-images") ||
      p.startsWith("/admin/settings/categories"),
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
    href: "/admin/settings/employees",
    label: "Team",
    icon: UserCog,
    group: "People",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/employees"),
  },
  {
    // Which features vendors, managers and riders get. BOTH: a list of
    // switches reads fine on a phone.
    href: "/admin/settings/features",
    label: "Feature access",
    icon: ToggleRight,
    group: "People",
    tone: "violet",
    match: (p) => p.startsWith("/admin/settings/features"),
  },
  {
    href: "/admin/observability",
    label: "Observability",
    icon: Activity,
    group: "System",
    // Console-only, like Platform config. Every screen under it is a dense
    // table, a stack trace or a waterfall — a phone can show none of those
    // usefully, and offering the destination on a handset only leads to a
    // notice. It keeps its rail entry and its page title.
    reach: "console",
    tone: "pop",
    match: (p) => p.startsWith("/admin/observability"),
  },
  {
    href: "/admin/settings/platform",
    label: "Platform config",
    icon: SlidersHorizontal,
    group: "System",
    reach: "console",
    tone: "blue",
    match: (p) => p.startsWith("/admin/settings/platform"),
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: Settings,
    group: "System",
    primary: true,
    tone: "violet",
    // Deliberately broad: it also covers sub-pages with no rail entry of their
    // own. Where a sub-page *does* have one, activeNavItem's longest-href rule
    // hands the highlight to that entry instead — which is why consumers must
    // resolve the active item through it, not by calling match() per item.
    match: (p) => p.startsWith("/admin/settings"),
  },
];

export const ADMIN_NAV_GROUPS = [
  "Overview",
  "Operations",
  "Catalogue",
  "People",
  "System",
] as const;

/**
 * Everything else the phone can actually use, for the Settings menu to list.
 * Derived rather than hand-written so a new nav item can't quietly become
 * unreachable on a handset — which is what happened to Refunds, Settlements,
 * Featured slots and Customers before this existed.
 */
export const ADMIN_PHONE_MENU = ADMIN_NAV.filter(
  (i) => !i.primary && i.reach !== "console"
);

/** Longest matching route wins, so /admin doesn't claim /admin/orders. */
export function activeNavItem(pathname: string): AdminNavItem | null {
  const hits = ADMIN_NAV.filter((i) => i.match(pathname));
  if (!hits.length) return null;
  return hits.reduce((best, i) => (i.href.length > best.href.length ? i : best));
}
