import 'package:flutter/material.dart';

import '../../models/manager_me.dart';

/// One bottom tab. A tab whose [permission] is off is not shown, and its path
/// redirects home (the server refuses its data anyway).
class TabDef {
  const TabDef(this.path, this.en, this.icon, this.selectedIcon, {this.permission});
  final String path;
  final String en;
  final IconData icon;
  final IconData selectedIcon;
  final String? permission;
}

const tabs = <TabDef>[
  TabDef('/', 'Home', Icons.space_dashboard_outlined, Icons.space_dashboard),
  TabDef('/orders', 'Orders', Icons.receipt_long_outlined, Icons.receipt_long,
      permission: 'manager.orders.view'),
  TabDef('/live', 'Live', Icons.map_outlined, Icons.map, permission: 'manager.live.view'),
  TabDef('/finance', 'Finance', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet,
      permission: 'manager.finance.view'),
  TabDef('/more', 'More', Icons.menu_rounded, Icons.menu_rounded),
];

/// One row of the More menu. [phase] names the build phase that delivers the
/// screen; until then it opens a labelled placeholder.
class MoreItem {
  const MoreItem(this.path, this.en, this.icon, {this.permission, this.phase, this.subtitleEn});
  final String path;
  final String en;
  final IconData icon;
  final String? permission;
  final int? phase;
  final String? subtitleEn;
}

const moreItems = <MoreItem>[
  MoreItem('/more/vendors', 'Vendors', Icons.storefront_outlined,
      permission: 'manager.vendors.view',
      subtitleEn: 'Onboarding, status, documents, performance'),
  MoreItem('/more/riders', 'Riders', Icons.two_wheeler_outlined,
      permission: 'manager.riders.view',
      subtitleEn: 'Availability, documents, deliveries, cash'),
  MoreItem('/more/approvals', 'Approvals', Icons.verified_outlined,
      permission: 'manager.finance.view',
      subtitleEn: 'Payouts one person asks for and another approves'),
  MoreItem('/more/cash', 'Cash deposits', Icons.account_balance_outlined,
      permission: 'manager.cash',
      subtitleEn: 'Confirm rider deposits, settle disputes'),
  MoreItem('/more/customers', 'Customers', Icons.people_outline,
      permission: 'manager.customers.view', phase: 7,
      subtitleEn: 'Accounts, orders, refunds, retention'),
  MoreItem('/more/products', 'Products', Icons.inventory_2_outlined,
      permission: 'manager.products.view',
      subtitleEn: 'Availability, prices, listings'),
  MoreItem('/more/marketing', 'Marketing', Icons.campaign_outlined,
      permission: 'manager.marketing.manage', phase: 7,
      subtitleEn: 'Requests and campaigns'),
  MoreItem('/more/offers', 'Offers', Icons.local_offer_outlined,
      permission: 'manager.offers.manage', phase: 7,
      subtitleEn: 'Promo codes and discounts'),
  MoreItem('/more/support', 'Support', Icons.support_agent_outlined,
      permission: 'manager.support.manage',
      subtitleEn: 'Tickets from vendors, riders and customers'),
  MoreItem('/more/reports', 'Reports', Icons.summarize_outlined,
      permission: 'manager.reports.view',
      subtitleEn: 'Twelve reports, Excel / CSV / PDF'),
  MoreItem('/more/alerts', 'Alerts', Icons.notifications_active_outlined, phase: 8,
      subtitleEn: 'What needs attention, and thresholds'),
  MoreItem('/more/audit', 'Audit log', Icons.fact_check_outlined,
      permission: 'manager.audit.view_zone', phase: 8,
      subtitleEn: 'Every recorded action in your zones'),
  MoreItem('/more/insights', 'Insights', Icons.insights_outlined,
      permission: 'manager.reports.view', phase: 9,
      subtitleEn: 'Forecasts, benchmarks, SLAs'),
  MoreItem('/more/profile', 'Profile & permissions', Icons.badge_outlined,
      subtitleEn: 'Zones, permissions, activity, devices'),
  MoreItem('/more/settings', 'Settings', Icons.settings_outlined,
      subtitleEn: 'Theme, updates'),
];

/// The rows this person may open.
List<MoreItem> moreItemsFor(ManagerMe me) =>
    moreItems.where((m) => m.permission == null || me.can(m.permission!)).toList();

/// The tabs this person may open, in order.
List<TabDef> tabsFor(ManagerMe me) =>
    tabs.where((t) => t.permission == null || me.can(t.permission!)).toList();

/// The permission a path needs, or null. Sub-paths inherit their parent's.
String? permissionFor(String path) {
  if (path == '/stats') return 'manager.reports.view';
  if (path == '/more/vendors/new') return 'manager.vendors.onboard';
  if (path == '/more/riders/new') return 'manager.riders.onboard';
  if (path == '/live/exceptions') return 'manager.riders.view';
  // A rider's ledger is money: it needs finance on top of riders.
  if (RegExp(r'^/more/riders/[^/]+/ledger$').hasMatch(path)) return 'manager.finance.view';
  if (path.startsWith('/more/tickets/')) return 'manager.support.manage';
  if (path == '/more/products/restricted') return 'manager.products.moderate';
  if (path == '/more/products/image-reviews') return 'manager.products.moderate';
  for (final t in tabs) {
    if (t.permission != null && (path == t.path || path.startsWith('${t.path}/'))) return t.permission;
  }
  for (final m in moreItems) {
    if (m.permission != null && (path == m.path || path.startsWith('${m.path}/'))) return m.permission;
  }
  return null;
}
