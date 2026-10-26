import {
  ClipboardList,
  IndianRupee,
  LayoutDashboard,
  Settings,
  Star,
  TicketPercent,
  User,
  UtensilsCrossed,
} from "lucide-react";
import type { FeatureKey } from "@/lib/features/catalog";

/**
 * One nav definition, three consumers: the web sidebar, the phone bottom tabs,
 * and the top bar's page title. The phone frame can only carry five tabs, so
 * `primary` marks the five that earn a slot there — Settings lives on the rail
 * and is one tap away from Profile.
 */
export interface VendorNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  group: "Overview" | "Kitchen" | "Catalogue" | "Money" | "Account";
  /** Shown on the phone's five-slot bottom bar. */
  primary?: boolean;
  tone: "green" | "blue" | "accent" | "deal" | "violet";
  match: (pathname: string) => boolean;
  /** Hidden when this switch is off for the shop (Admin → Feature access). */
  feature?: FeatureKey;
}

export const VENDOR_NAV: VendorNavItem[] = [
  {
    href: "/vendor",
    label: "Orders",
    icon: ClipboardList,
    group: "Kitchen",
    primary: true,
    tone: "accent",
    match: (p) => p === "/vendor",
  },
  {
    href: "/vendor/overview",
    feature: "vendor.earnings",
    label: "Overview",
    icon: LayoutDashboard,
    group: "Overview",
    primary: true,
    tone: "green",
    match: (p) => p.startsWith("/vendor/overview"),
  },
  {
    href: "/vendor/menu",
    label: "Menu",
    icon: UtensilsCrossed,
    group: "Catalogue",
    primary: true,
    tone: "blue",
    match: (p) => p.startsWith("/vendor/menu"),
  },
  {
    href: "/vendor/earnings",
    feature: "vendor.earnings",
    label: "Earnings",
    icon: IndianRupee,
    group: "Money",
    primary: true,
    tone: "green",
    match: (p) => p.startsWith("/vendor/earnings"),
  },
  {
    // Money, not Catalogue: a promo code is the shop spending its own item
    // revenue to buy orders, and it sits next to the screen that shows what
    // that revenue is.
    href: "/vendor/promotions",
    feature: "vendor.promotions",
    label: "Promotions",
    icon: TicketPercent,
    group: "Money",
    tone: "deal",
    match: (p) => p.startsWith("/vendor/promotions"),
  },
  {
    href: "/vendor/reviews",
    feature: "vendor.reviews",
    label: "Reviews",
    icon: Star,
    group: "Overview",
    tone: "deal",
    match: (p) => p.startsWith("/vendor/reviews"),
  },
  {
    href: "/vendor/profile",
    label: "Profile",
    icon: User,
    group: "Account",
    primary: true,
    tone: "violet",
    match: (p) => p.startsWith("/vendor/profile"),
  },
  {
    href: "/vendor/settings",
    feature: "vendor.shop_profile",
    label: "Settings",
    icon: Settings,
    group: "Account",
    tone: "blue",
    match: (p) => p.startsWith("/vendor/settings"),
  },
];

export const VENDOR_NAV_GROUPS = [
  "Overview",
  "Kitchen",
  "Catalogue",
  "Money",
  "Account",
] as const;

/** Nav items this shop may use: drops entries whose feature is switched off. */
export function visibleVendorNav<T extends VendorNavItem>(
  items: T[],
  features: Record<string, boolean>
): T[] {
  return items.filter((i) => !i.feature || features[i.feature] !== false);
}

/** The five that fit the phone's bottom bar. */
export const VENDOR_PHONE_TABS = VENDOR_NAV.filter((i) => i.primary);

/** Longest matching route wins, so /vendor doesn't claim /vendor/menu. */
export function activeVendorNavItem(pathname: string): VendorNavItem | null {
  const hits = VENDOR_NAV.filter((i) => i.match(pathname));
  if (!hits.length) return null;
  return hits.reduce((best, i) => (i.href.length > best.href.length ? i : best));
}
