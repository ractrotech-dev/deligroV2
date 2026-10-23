/// One of the eighteen dashboard figures (§1), in the client document's words.
/// [key] is the server's name for it; [target] is the list a tap opens.
enum FigureKey {
  todaysTotalSales('todaysTotalSales', "Today's Total Sales", money: true, target: '/orders?status=today'),
  totalSales('totalSales', 'Total Sales', money: true, target: '/more/reports?kind=sales'),
  todaysOrders('todaysOrders', "Today's Orders", target: '/orders?status=today'),
  totalOrders('totalOrders', 'Total Orders', target: '/orders'),
  pendingOrders('pendingOrders', 'Pending Orders', target: '/orders?status=pending'),
  completedOrders('completedOrders', 'Completed Orders', target: '/orders?status=completed'),
  cancelledOrders('cancelledOrders', 'Cancelled Orders', target: '/orders?status=cancelled'),
  activeVendors('activeVendors', 'Active Vendors', target: '/more/vendors?filter=active'),
  onlineVendors('onlineVendors', 'Online Vendors', target: '/more/vendors?filter=online'),
  activeRiders('activeRiders', 'Active Riders', target: '/more/riders?account=active'),
  onlineRiders('onlineRiders', 'Online Riders', target: '/more/riders?state=online,available,on_delivery'),
  ridersOnDelivery('ridersOnDelivery', 'Riders Currently on Delivery', target: '/more/riders?state=on_delivery'),
  totalDeliveryFees('totalDeliveryFees', 'Total Delivery Fees', money: true, target: '/finance'),
  totalPlatformCommission('totalPlatformCommission', 'Total Platform Commission',
      money: true, target: '/finance'),
  vendorPaymentsDue('vendorPaymentsDue', 'Vendor Payments Due', money: true, target: '/finance?tab=vendors'),
  riderPaymentsDue('riderPaymentsDue', 'Rider Payments Due', money: true,
      target: '/finance?tab=riders', pendingEn: 'Arrives with rider pay records'),
  pendingMarketingRequests('pendingMarketingRequests', 'Pending Marketing Requests',
      target: '/more/marketing?status=pending', pendingEn: 'Not available right now'),
  pendingSupportTickets('pendingSupportTickets', 'Pending Support Tickets',
      target: '/more/support?status=open', pendingEn: 'Not available right now'),
  ;

  const FigureKey(this.key, this.en,
      {this.money = false, required this.target, this.pendingEn = 'Not counted yet'});

  /// The permission the tile's target screen needs. Without it the tile is a
  /// figure, not a button — tapping it must not bounce to Home.
  String get permission {
    final path = Uri.parse(target).path;
    if (path.startsWith('/orders')) return 'manager.orders.view';
    if (path.startsWith('/live')) return 'manager.live.view';
    if (path.startsWith('/finance')) return 'manager.finance.view';
    if (path.startsWith('/more/reports')) return 'manager.reports.view';
    if (path.startsWith('/more/vendors')) return 'manager.vendors.view';
    if (path.startsWith('/more/riders')) return 'manager.riders.view';
    if (path.startsWith('/more/marketing')) return 'manager.marketing.manage';
    if (path.startsWith('/more/support')) return 'manager.support.manage';
    return 'manager.orders.view';
  }

  final String key;
  final String en;
  final bool money;
  final String target;

  /// Shown under "—" when the platform cannot count this figure yet.
  final String pendingEn;

  static FigureKey? fromKey(String key) {
    for (final f in values) {
      if (f.key == key) return f;
    }
    return null;
  }
}

/// GET /api/manager/dashboard.
class DashboardData {
  const DashboardData({
    required this.today,
    required this.generatedAt,
    required this.order,
    required this.figures,
    required this.unavailable,
  });

  /// The IST day "today" means, YYYY-MM-DD.
  final String today;
  final DateTime? generatedAt;

  /// The figures this person may see, in the document's order.
  final List<FigureKey> order;

  /// Null = not counted yet (see [unavailable]).
  final Map<FigureKey, num?> figures;
  final Set<FigureKey> unavailable;

  factory DashboardData.fromJson(Map<String, dynamic> j) {
    final order = <FigureKey>[
      for (final k in (j['order'] as List? ?? const [])) ?FigureKey.fromKey('$k'),
    ];
    final raw = (j['figures'] as Map?) ?? const {};
    return DashboardData(
      today: '${j['today'] ?? ''}',
      generatedAt: DateTime.tryParse('${j['generatedAt'] ?? ''}'),
      order: order,
      figures: {for (final f in order) f: raw[f.key] is num ? raw[f.key] as num : null},
      unavailable: {
        for (final k in (j['unavailable'] as List? ?? const [])) ?FigureKey.fromKey('$k'),
      },
    );
  }
}
