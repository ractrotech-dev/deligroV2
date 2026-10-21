import 'package:flutter/material.dart' show DateTimeRange;
import 'package:intl/intl.dart';

/// The statistics period (§2.2–2.3).
enum Period { day, week, month, year, custom }

/// What the statistics screen asks for: a preset period or a custom range,
/// optionally one zone.
class StatsQuery {
  const StatsQuery({required this.period, this.custom, this.zoneId});
  final Period period;
  final DateTimeRange? custom;
  final String? zoneId;

  static final _day = DateFormat('yyyy-MM-dd');

  Map<String, String> toQuery() => {
        'granularity': period.name,
        if (period == Period.custom && custom != null) ...{
          'from': _day.format(custom!.start),
          'to': _day.format(custom!.end),
        },
        'zone': ?zoneId,
      };

  StatsQuery withZone(String? zone) => StatsQuery(period: period, custom: custom, zoneId: zone);

  @override
  bool operator ==(Object other) =>
      other is StatsQuery && other.period == period && other.custom == custom && other.zoneId == zoneId;

  @override
  int get hashCode => Object.hash(period, custom, zoneId);
}

num _n(Object? v) => v is num ? v : 0;
int _i(Object? v) => _n(v).round();
Map<String, dynamic> _m(Object? v) => v is Map ? v.cast<String, dynamic>() : const {};
List<Map<String, dynamic>> _l(Object? v) => [for (final x in (v is List ? v : const [])) _m(x)];

class Growth {
  const Growth({required this.current, required this.previous, required this.pct});
  final num current;
  final num previous;

  /// Null when the previous period was zero and this one is not: "New".
  final double? pct;

  factory Growth.fromJson(Map<String, dynamic> j) => Growth(
        current: _n(j['current']),
        previous: _n(j['previous']),
        pct: j['pct'] is num ? (j['pct'] as num).toDouble() : null,
      );
}

class SeriesPoint {
  const SeriesPoint({required this.date, required this.orders, required this.sales, required this.cancelled});
  final String date;
  final int orders;
  final int sales;
  final int cancelled;

  factory SeriesPoint.fromJson(Map<String, dynamic> j) =>
      SeriesPoint(date: '${j['date']}', orders: _i(j['orders']), sales: _i(j['sales']), cancelled: _i(j['cancelled']));
}

class CountValue {
  const CountValue(this.count, this.value);
  final int count;
  final int value;
  factory CountValue.fromJson(Map<String, dynamic> j) => CountValue(_i(j['count']), _i(j['value']));
}

class VendorRank {
  const VendorRank({required this.id, required this.name, required this.orders, required this.sales, required this.rating});
  final String id;
  final String name;
  final int orders;
  final int sales;
  final double? rating;
  factory VendorRank.fromJson(Map<String, dynamic> j) => VendorRank(
        id: '${j['restaurantId']}',
        name: '${j['name'] ?? ''}',
        orders: _i(j['orders']),
        sales: _i(j['sales']),
        rating: j['rating'] is num ? (j['rating'] as num).toDouble() : null,
      );
}

class CategoryRank {
  const CategoryRank({required this.category, required this.sales, required this.qty});
  final String category;
  final int sales;
  final int qty;
  factory CategoryRank.fromJson(Map<String, dynamic> j) =>
      CategoryRank(category: '${j['category'] ?? ''}', sales: _i(j['sales']), qty: _i(j['qty']));
}

class ZoneRow {
  const ZoneRow({required this.zoneName, required this.cityName, required this.orders, required this.sales});
  final String zoneName;
  final String? cityName;
  final int orders;
  final int sales;
  factory ZoneRow.fromJson(Map<String, dynamic> j) => ZoneRow(
        zoneName: '${j['zoneName'] ?? ''}',
        cityName: j['cityName'] is String ? j['cityName'] as String : null,
        orders: _i(j['orders']),
        sales: _i(j['sales']),
      );
}

/// GET /api/manager/stats.
class StatsData {
  const StatsData({
    required this.generatedAt,
    required this.granularity,
    required this.from,
    required this.to,
    required this.previousFrom,
    required this.previousTo,
    required this.orders,
    required this.sales,
    required this.grossSales,
    required this.netSales,
    required this.discounts,
    required this.refunds,
    required this.deliveryFees,
    required this.daily,
    required this.bucketGranularity,
    required this.buckets,
    required this.salesGrowth,
    required this.ordersGrowth,
    required this.aov,
    required this.aovGrowth,
    required this.completed,
    required this.cancelled,
    required this.completionRate,
    required this.cancellationRate,
    required this.cancelledBy,
    required this.topReasons,
    required this.peakGrid,
    required this.topHours,
    required this.bestVendors,
    required this.bestCategories,
    required this.byZone,
  });

  final DateTime? generatedAt;
  final String granularity;
  final String from;
  final String to;
  final String previousFrom;
  final String previousTo;

  /// Non-cancelled orders, and what customers paid for them.
  final int orders;
  final int sales;
  final int grossSales;
  /// Finance figures: null when the server left them out (no
  /// `manager.finance.view`). Never shown, never exported, never zero-filled.
  final int? netSales;
  final int? discounts;
  final int? refunds;
  final int? deliveryFees;
  final List<SeriesPoint> daily;
  final String bucketGranularity;
  final List<SeriesPoint> buckets;
  final Growth salesGrowth;
  final Growth ordersGrowth;
  final int aov;
  final Growth aovGrowth;
  final CountValue completed;
  final CountValue cancelled;
  final double completionRate;
  final double cancellationRate;

  /// Who cancelled (customer, vendor, manager, admin, system, unknown) → count.
  final Map<String, int> cancelledBy;
  final List<({String reason, int count})> topReasons;

  /// 7 rows (Monday first) × 24 hours of orders.
  final List<List<int>> peakGrid;
  final List<({int hour, int orders})> topHours;
  final List<VendorRank> bestVendors;
  final List<CategoryRank> bestCategories;
  final List<ZoneRow> byZone;

  bool get isEmpty => orders == 0 && cancelled.count == 0;

  factory StatsData.fromJson(Map<String, dynamic> j) {
    final summary = _m(j['summary']);
    final range = _m(j['range']);
    final previous = _m(j['previous']);
    final growth = _m(j['growth']);
    final aov = _m(j['averageOrderValue']);
    final cvc = _m(j['completedVsCancelled']);
    final peak = _m(j['peakHours']);
    return StatsData(
      generatedAt: DateTime.tryParse('${j['generatedAt'] ?? ''}'),
      granularity: '${j['granularity'] ?? 'month'}',
      from: '${range['from'] ?? ''}',
      to: '${range['to'] ?? ''}',
      previousFrom: '${previous['from'] ?? ''}',
      previousTo: '${previous['to'] ?? ''}',
      orders: _i(summary['orders']),
      sales: _i(summary['customerPaid']),
      grossSales: _i(summary['grossSales']),
      netSales: summary.containsKey('netSales') ? _i(summary['netSales']) : null,
      discounts: summary.containsKey('discounts') ? _i(_m(summary['discounts'])['total']) : null,
      refunds: summary.containsKey('refunds') ? _i(_m(summary['refunds'])['total']) : null,
      deliveryFees: summary.containsKey('deliveryFees') ? _i(summary['deliveryFees']) : null,
      daily: [for (final p in _l(j['daily'])) SeriesPoint.fromJson(p)],
      bucketGranularity: '${j['bucketGranularity'] ?? 'day'}',
      buckets: [for (final p in _l(j['buckets'])) SeriesPoint.fromJson(p)],
      salesGrowth: Growth.fromJson(_m(growth['sales'])),
      ordersGrowth: Growth.fromJson(_m(growth['orders'])),
      aov: _i(aov['current']),
      aovGrowth: Growth.fromJson(_m(aov['growth'])),
      completed: CountValue.fromJson(_m(cvc['completed'])),
      cancelled: CountValue.fromJson(_m(cvc['cancelled'])),
      completionRate: _n(cvc['completionRate']).toDouble(),
      cancellationRate: _n(cvc['cancellationRate']).toDouble(),
      cancelledBy: {for (final e in _m(cvc['byCancelledBy']).entries) e.key: _i(_m(e.value)['count'])},
      topReasons: [for (final r in _l(cvc['topReasons'])) (reason: '${r['reason'] ?? ''}', count: _i(r['count']))],
      peakGrid: [
        for (final row in (peak['grid'] is List ? peak['grid'] as List : const []))
          [for (final v in (row is List ? row : const [])) _i(v)],
      ],
      topHours: [for (final h in _l(peak['topHours'])) (hour: _i(h['hour']), orders: _i(h['orders']))],
      bestVendors: [for (final v in _l(j['bestVendors'])) VendorRank.fromJson(v)],
      bestCategories: [for (final c in _l(j['bestCategories'])) CategoryRank.fromJson(c)],
      byZone: [for (final z in _l(j['byZone'])) ZoneRow.fromJson(z)],
    );
  }
}
