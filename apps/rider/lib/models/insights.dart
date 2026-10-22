/// History and Performance as `/api/rider/history`, `/api/rider/history/:id`
/// and `/api/rider/performance` send them (src/lib/data-access/rider-insights.ts).
/// Timestamps are ISO strings (UTC); rupees are JSON numbers; a rate is a
/// percent 0-100 or null when there is nothing to divide.
library;

import 'jobs.dart' show RiderEvent;

double? _num(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

int _int(Object? v) => _num(v)?.round() ?? 0;

String? _str(Object? v) {
  if (v is! String) return null;
  final t = v.trim();
  return t.isEmpty ? null : t;
}

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

Map<String, dynamic> _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : const <String, dynamic>{};

List<Map<String, dynamic>> _maps(Object? v) => [
  for (final e in (v is List ? v : const []))
    if (e is Map) Map<String, dynamic>.from(e),
];

/// How a finished job ended. [wire] is what the server sends and takes.
enum HistoryOutcome {
  delivered('delivered', 'Delivered'),
  failed('failed', 'Failed'),
  cancelled('cancelled', 'Cancelled'),
  reassigned('reassigned', 'Reassigned'),

  /// A status this app does not know: shown neutrally, never as Cancelled.
  other('other', 'Other');

  const HistoryOutcome(this.wire, this.label);

  final String wire;
  final String label;

  /// The outcomes the filter chips offer (and the server accepts).
  static const filterable = [delivered, failed, cancelled, reassigned];

  static HistoryOutcome? tryParse(Object? v) {
    for (final o in filterable) {
      if (o.wire == v) return o;
    }
    return null;
  }
}

/// One finished delivery, a History row.
class HistoryItem {
  const HistoryItem({
    required this.orderId,
    required this.code,
    required this.shop,
    this.dropArea,
    required this.outcome,
    this.acceptedAt,
    this.pickedUpAt,
    this.deliveredAt,
    required this.endedAt,
    this.distanceKm,
    this.earning,
    this.reason,
    this.cancelledBy,
    this.proof,
    this.itemCount = 0,
    this.orderValue = 0,
  });

  final String orderId;
  final String code;
  final String shop;
  final String? dropArea;
  final HistoryOutcome outcome;
  final DateTime? acceptedAt;
  final DateTime? pickedUpAt;
  final DateTime? deliveredAt;
  final DateTime endedAt;
  final double? distanceKm;

  /// A recorded ledger amount, or null (nothing recorded, ₹0, or money hidden).
  final double? earning;
  final String? reason;

  /// `customer`, `vendor`, `manager`, `admin`, `system` (cancelled jobs only).
  final String? cancelledBy;

  /// `code`, `photo`, `ops_approved`, `staff` (or `vendor`), delivered jobs only.
  final String? proof;
  final int itemCount;
  final double orderValue;

  /// Whether the row has a real earning to show. A ₹0 row is never money
  /// (riders are on a fixed salary).
  bool get hasEarning => earning != null && earning != 0;

  /// Accept to end, when both are known.
  Duration? get took {
    final a = acceptedAt;
    if (a == null) return null;
    final d = endedAt.difference(a);
    return d.isNegative ? null : d;
  }

  factory HistoryItem.fromJson(Map<String, dynamic> j) => HistoryItem(
    orderId: '${j['orderId']}',
    code: '${j['code'] ?? ''}',
    shop: '${j['shop'] ?? ''}',
    dropArea: _str(j['dropArea']),
    outcome: HistoryOutcome.tryParse(j['outcome']) ?? HistoryOutcome.other,
    acceptedAt: _date(j['acceptedAt']),
    pickedUpAt: _date(j['pickedUpAt']),
    deliveredAt: _date(j['deliveredAt']),
    endedAt:
        _date(j['endedAt']) ??
        DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    distanceKm: _num(j['distanceKm']),
    earning: _num(j['earning']),
    reason: _str(j['reason']),
    cancelledBy: _str(j['cancelledBy']),
    proof: _str(j['proof']),
    itemCount: _int(j['itemCount']),
    orderValue: _num(j['orderValue']) ?? 0,
  );
}

/// One page of `GET /api/rider/history`.
class HistoryPage {
  const HistoryPage({required this.items, this.nextCursor});

  final List<HistoryItem> items;
  final String? nextCursor;

  factory HistoryPage.fromJson(Map<String, dynamic> j) => HistoryPage(
    items: _maps(j['items']).map(HistoryItem.fromJson).toList(),
    nextCursor: _str(j['nextCursor']),
  );
}

class OrderLine {
  const OrderLine({required this.name, required this.qty});

  final String name;
  final int qty;
}

/// `GET /api/rider/history/:orderId`.
class HistoryDetail {
  const HistoryDetail({
    required this.item,
    this.timeline = const [],
    this.proofPhotoUrl,
    this.lines = const [],
  });

  final HistoryItem item;
  final List<RiderEvent> timeline;

  /// A 10-minute signed link; null when there is no photo.
  final String? proofPhotoUrl;
  final List<OrderLine> lines;

  factory HistoryDetail.fromJson(Map<String, dynamic> j) => HistoryDetail(
    item: HistoryItem.fromJson(j),
    timeline: _maps(j['timeline']).map(RiderEvent.fromJson).toList(),
    proofPhotoUrl: _str(j['proofPhotoUrl']),
    lines: [
      for (final l in _maps(j['items']))
        OrderLine(name: '${l['name'] ?? ''}', qty: _int(l['qty'])),
    ],
  );
}

/// A target and how far the rider is (0 = no target to show).
class TargetProgress {
  const TargetProgress({required this.target, required this.done});

  final int target;
  final int done;

  bool get hasTarget => target > 0;

  /// 0..1, never NaN.
  double get fraction => target <= 0 ? 0 : (done / target).clamp(0.0, 1.0);

  factory TargetProgress.fromJson(Map<String, dynamic> j) =>
      TargetProgress(target: _int(j['target']), done: _int(j['done']));
}

class RecentRating {
  const RecentRating({required this.rating, this.comment, this.at});

  final int rating;
  final String? comment;
  final DateTime? at;
}

class RatingBlock {
  const RatingBlock({this.average, this.count = 0, this.recent = const []});

  final double? average;
  final int count;
  final List<RecentRating> recent;

  factory RatingBlock.fromJson(Map<String, dynamic> j) => RatingBlock(
    average: _num(j['average']),
    count: _int(j['count']),
    recent: [
      for (final r in _maps(j['recent']))
        RecentRating(
          rating: _int(r['rating']),
          comment: _str(r['comment']),
          at: _date(r['at']),
        ),
    ],
  );
}

/// One row of the monthly report.
class MonthRow {
  const MonthRow({
    required this.month,
    this.delivered = 0,
    this.failed = 0,
    this.cancelled = 0,
    this.acceptanceRate,
    this.avgDeliverMin,
    this.earnings,
    this.onlineHours = 0,
  });

  /// `YYYY-MM` (IST).
  final String month;
  final int delivered;
  final int failed;
  final int cancelled;
  final double? acceptanceRate;
  final double? avgDeliverMin;
  final double? earnings;
  final double onlineHours;

  factory MonthRow.fromJson(Map<String, dynamic> j) => MonthRow(
    month: '${j['month']}',
    delivered: _int(j['delivered']),
    failed: _int(j['failed']),
    cancelled: _int(j['cancelled']),
    acceptanceRate: _num(j['acceptanceRate']),
    avgDeliverMin: _num(j['avgDeliverMin']),
    earnings: _num(j['earnings']),
    onlineHours: _num(j['onlineHours']) ?? 0,
  );
}

/// `GET /api/rider/performance`. The averages and rates look back 30 days;
/// [months] arrives newest first.
class RiderPerformance {
  const RiderPerformance({
    this.daily = const TargetProgress(target: 0, done: 0),
    this.weekly = const TargetProgress(target: 0, done: 0),
    this.avgAcceptToDeliverMin,
    this.avgPickupToDeliverMin,
    this.acceptanceRate,
    this.failedRate,
    this.onlineHoursThisWeek = 0,
    this.rating = const RatingBlock(),
    this.months = const [],
  });

  final TargetProgress daily;
  final TargetProgress weekly;
  final double? avgAcceptToDeliverMin;
  final double? avgPickupToDeliverMin;
  final double? acceptanceRate;
  final double? failedRate;
  final double onlineHoursThisWeek;
  final RatingBlock rating;
  final List<MonthRow> months;

  factory RiderPerformance.fromJson(Map<String, dynamic> j) => RiderPerformance(
    daily: TargetProgress.fromJson(_map(j['daily'])),
    weekly: TargetProgress.fromJson(_map(j['weekly'])),
    avgAcceptToDeliverMin: _num(j['avgAcceptToDeliverMin']),
    avgPickupToDeliverMin: _num(j['avgPickupToDeliverMin']),
    acceptanceRate: _num(j['acceptanceRate']),
    failedRate: _num(j['failedRate']),
    onlineHoursThisWeek: _num(j['onlineHoursThisWeek']) ?? 0,
    rating: RatingBlock.fromJson(_map(j['rating'])),
    months: _maps(j['months']).map(MonthRow.fromJson).toList(),
  );
}
