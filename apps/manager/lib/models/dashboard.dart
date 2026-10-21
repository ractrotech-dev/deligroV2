/// One of the eighteen dashboard figures (§1), in the client document's words.
/// [key] is the server's name for it; [target] is the list a tap opens.
enum FigureKey {
  todaysTotalSales('todaysTotalSales', "Today's Total Sales", 'आज की कुल बिक्री', money: true, target: '/orders?status=today'),
  totalSales('totalSales', 'Total Sales', 'कुल बिक्री', money: true, target: '/more/reports?kind=sales'),
  todaysOrders('todaysOrders', "Today's Orders", 'आज के ऑर्डर', target: '/orders?status=today'),
  totalOrders('totalOrders', 'Total Orders', 'कुल ऑर्डर', target: '/orders'),
  pendingOrders('pendingOrders', 'Pending Orders', 'लंबित ऑर्डर', target: '/orders?status=pending'),
  completedOrders('completedOrders', 'Completed Orders', 'पूरे हुए ऑर्डर', target: '/orders?status=completed'),
  cancelledOrders('cancelledOrders', 'Cancelled Orders', 'रद्द ऑर्डर', target: '/orders?status=cancelled'),
  activeVendors('activeVendors', 'Active Vendors', 'सक्रिय वेंडर', target: '/more/vendors?filter=active'),
  onlineVendors('onlineVendors', 'Online Vendors', 'ऑनलाइन वेंडर', target: '/more/vendors?filter=online'),
  activeRiders('activeRiders', 'Active Riders', 'सक्रिय राइडर', target: '/more/riders?filter=active'),
  onlineRiders('onlineRiders', 'Online Riders', 'ऑनलाइन राइडर', target: '/more/riders?filter=online'),
  ridersOnDelivery('ridersOnDelivery', 'Riders Currently on Delivery', 'डिलीवरी पर राइडर', target: '/live'),
  totalDeliveryFees('totalDeliveryFees', 'Total Delivery Fees', 'कुल डिलीवरी शुल्क', money: true, target: '/finance'),
  totalPlatformCommission('totalPlatformCommission', 'Total Platform Commission', 'कुल प्लेटफ़ॉर्म कमीशन',
      money: true, target: '/finance'),
  vendorPaymentsDue('vendorPaymentsDue', 'Vendor Payments Due', 'वेंडर का बकाया भुगतान', money: true, target: '/finance?tab=vendors'),
  riderPaymentsDue('riderPaymentsDue', 'Rider Payments Due', 'राइडर का बकाया भुगतान', money: true,
      target: '/finance?tab=riders', pendingEn: 'Arrives with rider pay records', pendingHi: 'राइडर भुगतान रिकॉर्ड के साथ आएगा'),
  pendingMarketingRequests('pendingMarketingRequests', 'Pending Marketing Requests', 'लंबित मार्केटिंग अनुरोध',
      target: '/more/marketing?status=pending', pendingEn: 'Arrives with marketing requests', pendingHi: 'मार्केटिंग अनुरोधों के साथ आएगा'),
  pendingSupportTickets('pendingSupportTickets', 'Pending Support Tickets', 'लंबित सपोर्ट टिकट',
      target: '/more/support?status=open', pendingEn: 'Arrives with support tickets', pendingHi: 'सपोर्ट टिकट के साथ आएगा'),
  ;

  const FigureKey(this.key, this.en, this.hi,
      {this.money = false, required this.target, this.pendingEn = 'Not counted yet', this.pendingHi = 'अभी गिना नहीं जाता'});

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
  final String hi;
  final bool money;
  final String target;

  /// Shown under "—" when the platform cannot count this figure yet.
  final String pendingEn;
  final String pendingHi;

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
