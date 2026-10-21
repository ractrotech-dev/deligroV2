/// A /api/manager/stats payload for tests: a month, two vendors, one
/// cancellation, sales down on the period before and AOV new.
Map<String, dynamic> statsJson({bool empty = false}) {
  final days = [for (var d = 1; d <= 21; d++) '2026-10-${d.toString().padLeft(2, '0')}'];
  Map<String, dynamic> point(String date, int i) =>
      {'date': date, 'orders': empty ? 0 : i % 3, 'sales': empty ? 0 : (i % 3) * 250, 'cancelled': 0};
  final grid = [
    for (var w = 0; w < 7; w++) [for (var h = 0; h < 24; h++) empty ? 0 : (w == 4 && h == 20 ? 9 : (h % 5))],
  ];
  return {
    'generatedAt': '2026-10-21T09:30:00.000Z',
    'granularity': 'month',
    'range': {'from': '2026-10-01', 'to': '2026-10-21'},
    'previous': {'from': '2026-09-10', 'to': '2026-09-30'},
    'zone': null,
    'summary': {
      'orders': empty ? 0 : 21,
      'grossSales': 5400,
      'customerPaid': empty ? 0 : 5250,
      'discounts': {'vendor': 100, 'platform': 50, 'total': 150},
      'refunds': {'total': 200, 'count': 1, 'onCancelled': 0},
      'netSales': 5050,
      'cancelled': {'count': empty ? 0 : 1, 'value': empty ? 0 : 999},
      'deliveryFees': 630,
      'averageOrderValue': empty ? 0 : 250,
    },
    'daily': [for (var i = 0; i < days.length; i++) point(days[i], i)],
    'bucketGranularity': 'day',
    'buckets': [for (var i = 0; i < days.length; i++) point(days[i], i)],
    'growth': {
      'sales': {'current': 5250, 'previous': 6000, 'change': -750, 'pct': -12.5},
      'orders': {'current': 21, 'previous': 0, 'change': 21, 'pct': null},
    },
    'averageOrderValue': {
      'current': 250,
      'previous': 0,
      'growth': {'current': 250, 'previous': 0, 'change': 250, 'pct': null},
    },
    'completedVsCancelled': {
      'completed': {'count': empty ? 0 : 20, 'value': 5000},
      'cancelled': {'count': empty ? 0 : 1, 'value': 999},
      'completionRate': 0.95,
      'cancellationRate': 0.05,
      'byCancelledBy': {
        'customer': {'count': 0, 'value': 0},
        'vendor': {'count': empty ? 0 : 1, 'value': 999},
        'manager': {'count': 0, 'value': 0},
        'admin': {'count': 0, 'value': 0},
        'system': {'count': 0, 'value': 0},
        'unknown': {'count': 0, 'value': 0},
      },
      'topReasons': empty ? [] : [{'reason': 'Out of stock', 'count': 1}],
    },
    'peakHours': {
      'grid': grid,
      'topHours': empty ? [] : [{'hour': 20, 'orders': 30}, {'hour': 4, 'orders': 28}],
    },
    'bestVendors': empty
        ? []
        : [
            {'restaurantId': 'r1', 'name': 'Spice Hub', 'orders': 12, 'sales': 3200, 'averageOrderValue': 266, 'cancelled': 0, 'refunds': 0, 'rating': 4.4},
            {'restaurantId': 'r2', 'name': 'Tandoor, Bemetara', 'orders': 9, 'sales': 2050, 'averageOrderValue': 227, 'cancelled': 1, 'refunds': 200, 'rating': null},
          ],
    'bestCategories': empty ? [] : [{'category': 'Mains', 'sales': 2400, 'qty': 30, 'orders': 14}],
    'byZone': empty
        ? []
        : [{'zoneId': 'z1', 'zoneName': 'Central', 'cityName': 'Bemetara', 'orders': 21, 'sales': 5250, 'cancelled': 1, 'averageOrderValue': 250}],
  };
}
