import 'package:flutter/material.dart';

import '../../models/manager_me.dart';

/// One bottom tab. A tab whose [permission] is off is not shown, and its path
/// redirects home (the server refuses its data anyway).
class TabDef {
  const TabDef(this.path, this.en, this.hi, this.icon, this.selectedIcon, {this.permission});
  final String path;
  final String en;
  final String hi;
  final IconData icon;
  final IconData selectedIcon;
  final String? permission;
}

const tabs = <TabDef>[
  TabDef('/', 'Home', 'होम', Icons.space_dashboard_outlined, Icons.space_dashboard),
  TabDef('/orders', 'Orders', 'ऑर्डर', Icons.receipt_long_outlined, Icons.receipt_long,
      permission: 'manager.orders.view'),
  TabDef('/live', 'Live', 'लाइव', Icons.map_outlined, Icons.map, permission: 'manager.live.view'),
  TabDef('/finance', 'Finance', 'वित्त', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet,
      permission: 'manager.finance.view'),
  TabDef('/more', 'More', 'और', Icons.menu_rounded, Icons.menu_rounded),
];

/// One row of the More menu. [phase] names the build phase that delivers the
/// screen; until then it opens a labelled placeholder.
class MoreItem {
  const MoreItem(this.path, this.en, this.hi, this.icon, {this.permission, this.phase, this.subtitleEn, this.subtitleHi});
  final String path;
  final String en;
  final String hi;
  final IconData icon;
  final String? permission;
  final int? phase;
  final String? subtitleEn;
  final String? subtitleHi;
}

const moreItems = <MoreItem>[
  MoreItem('/more/vendors', 'Vendors', 'वेंडर', Icons.storefront_outlined,
      permission: 'manager.vendors.view', phase: 4,
      subtitleEn: 'Onboarding, status, documents, performance', subtitleHi: 'ऑनबोर्डिंग, स्टेटस, दस्तावेज़, प्रदर्शन'),
  MoreItem('/more/riders', 'Riders', 'राइडर', Icons.two_wheeler_outlined,
      permission: 'manager.riders.view', phase: 5,
      subtitleEn: 'Availability, documents, deliveries, cash', subtitleHi: 'उपलब्धता, दस्तावेज़, डिलीवरी, नकद'),
  MoreItem('/more/customers', 'Customers', 'ग्राहक', Icons.people_outline,
      permission: 'manager.customers.view', phase: 7,
      subtitleEn: 'Accounts, orders, refunds, retention', subtitleHi: 'खाते, ऑर्डर, रिफ़ंड, रिटेंशन'),
  MoreItem('/more/products', 'Products', 'प्रोडक्ट', Icons.inventory_2_outlined,
      permission: 'manager.products.view', phase: 4,
      subtitleEn: 'Availability, prices, listings', subtitleHi: 'उपलब्धता, कीमतें, लिस्टिंग'),
  MoreItem('/more/marketing', 'Marketing', 'मार्केटिंग', Icons.campaign_outlined,
      permission: 'manager.marketing.manage', phase: 7,
      subtitleEn: 'Requests and campaigns', subtitleHi: 'अनुरोध और कैंपेन'),
  MoreItem('/more/offers', 'Offers', 'ऑफ़र', Icons.local_offer_outlined,
      permission: 'manager.offers.manage', phase: 7,
      subtitleEn: 'Promo codes and discounts', subtitleHi: 'प्रोमो कोड और छूट'),
  MoreItem('/more/support', 'Support', 'सपोर्ट', Icons.support_agent_outlined,
      permission: 'manager.support.manage', phase: 8,
      subtitleEn: 'Tickets from vendors, riders and customers', subtitleHi: 'वेंडर, राइडर और ग्राहकों के टिकट'),
  MoreItem('/more/reports', 'Reports', 'रिपोर्ट', Icons.summarize_outlined,
      permission: 'manager.reports.view', phase: 6,
      subtitleEn: 'Twelve reports, Excel / CSV / PDF', subtitleHi: 'बारह रिपोर्ट, Excel / CSV / PDF'),
  MoreItem('/more/alerts', 'Alerts', 'अलर्ट', Icons.notifications_active_outlined, phase: 8,
      subtitleEn: 'What needs attention, and thresholds', subtitleHi: 'किस पर ध्यान देना है, और सीमाएँ'),
  MoreItem('/more/audit', 'Audit log', 'ऑडिट लॉग', Icons.fact_check_outlined,
      permission: 'manager.audit.view_zone', phase: 8,
      subtitleEn: 'Every recorded action in your zones', subtitleHi: 'आपके ज़ोन के सभी दर्ज काम'),
  MoreItem('/more/insights', 'Insights', 'इनसाइट्स', Icons.insights_outlined,
      permission: 'manager.reports.view', phase: 9,
      subtitleEn: 'Forecasts, benchmarks, SLAs', subtitleHi: 'अनुमान, तुलना, SLA'),
  MoreItem('/more/profile', 'Profile & permissions', 'प्रोफ़ाइल और अनुमतियाँ', Icons.badge_outlined,
      subtitleEn: 'Zones, permissions, activity, devices', subtitleHi: 'ज़ोन, अनुमतियाँ, गतिविधि, डिवाइस'),
  MoreItem('/more/settings', 'Settings', 'सेटिंग्स', Icons.settings_outlined,
      subtitleEn: 'Language, theme, updates', subtitleHi: 'भाषा, थीम, अपडेट'),
];

/// The rows this person may open.
List<MoreItem> moreItemsFor(ManagerMe me) =>
    moreItems.where((m) => m.permission == null || me.can(m.permission!)).toList();

/// The tabs this person may open, in order.
List<TabDef> tabsFor(ManagerMe me) =>
    tabs.where((t) => t.permission == null || me.can(t.permission!)).toList();

/// The permission a path needs, or null. Sub-paths inherit their parent's.
String? permissionFor(String path) {
  for (final t in tabs) {
    if (t.permission != null && (path == t.path || path.startsWith('${t.path}/'))) return t.permission;
  }
  for (final m in moreItems) {
    if (m.permission != null && (path == m.path || path.startsWith('${m.path}/'))) return m.permission;
  }
  return null;
}
