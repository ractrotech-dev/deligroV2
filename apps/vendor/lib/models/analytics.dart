/// `/api/vendor/analytics` (src/lib/vendor/analytics.ts).
class Analytics {
  const Analytics({
    required this.unit,
    required this.from,
    required this.to,
    required this.buckets,
    required this.sales,
    required this.orders,
    required this.averageOrderValue,
    required this.salesChange,
    required this.ordersChange,
    required this.averageOrderValueChange,
    required this.bestDays,
    required this.hours,
    required this.peak,
    required this.bestSellers,
    required this.slowMovers,
  });

  factory Analytics.fromJson(Map<String, dynamic> j) {
    final w = ((j['window'] as Map?) ?? const {}).cast<String, dynamic>();
    final t = ((j['totals'] as Map?) ?? const {}).cast<String, dynamic>();
    List<Map<String, dynamic>> list(String k) => [
      for (final e in (j[k] as List? ?? const [])) (e as Map).cast<String, dynamic>(),
    ];
    int n(Map<String, dynamic> m, String k) => (m[k] as num?)?.round() ?? 0;
    double? d(String k) => (t[k] as num?)?.toDouble();
    final peak = (j['peak'] as Map?)?.cast<String, dynamic>();
    return Analytics(
      unit: '${w['unit'] ?? 'day'}',
      from: DateTime.parse('${w['from']}'),
      to: DateTime.parse('${w['to']}'),
      buckets: [
        for (final b in list('buckets'))
          AnalyticsBucket(
            start: DateTime.parse('${b['start']}'),
            sales: n(b, 'sales'),
            orders: n(b, 'orders'),
            prevSales: n(b, 'prevSales'),
          ),
      ],
      sales: n(t, 'sales'),
      orders: n(t, 'orders'),
      averageOrderValue: n(t, 'averageOrderValue'),
      salesChange: d('salesChange'),
      ordersChange: d('ordersChange'),
      averageOrderValueChange: d('averageOrderValueChange'),
      bestDays: [
        for (final b in list('bestDays'))
          (day: DateTime.parse('${b['day']}'), sales: n(b, 'sales'), orders: n(b, 'orders')),
      ],
      hours: [for (final h in list('hours')) (hour: n(h, 'hour'), sales: n(h, 'sales'), orders: n(h, 'orders'))],
      peak: peak == null ? null : (fromHour: n(peak, 'fromHour'), toHour: n(peak, 'toHour'), sales: n(peak, 'sales')),
      bestSellers: [
        for (final s in list('bestSellers')) (name: '${s['name']}', qty: n(s, 'qty'), revenue: n(s, 'revenue')),
      ],
      slowMovers: [
        for (final s in list('slowMovers')) (name: '${s['name']}', qty: n(s, 'qty'), revenue: n(s, 'revenue')),
      ],
    );
  }

  /// `day`, `week`, `month` or `year` — how [buckets] are cut.
  final String unit;
  final DateTime from;
  final DateTime to;
  final List<AnalyticsBucket> buckets;
  final int sales;
  final int orders;
  final int averageOrderValue;
  final double? salesChange;
  final double? ordersChange;
  final double? averageOrderValueChange;
  final List<({DateTime day, int sales, int orders})> bestDays;
  final List<({int hour, int sales, int orders})> hours;
  final ({int fromHour, int toHour, int sales})? peak;
  final List<({String name, int qty, int revenue})> bestSellers;
  final List<({String name, int qty, int revenue})> slowMovers;
}

class AnalyticsBucket {
  const AnalyticsBucket({required this.start, required this.sales, required this.orders, required this.prevSales});
  final DateTime start;
  final int sales;
  final int orders;
  final int prevSales;
}
