/// The rider's money as `/api/rider/earnings/*` sends it (src/lib/rider/earnings-math.ts).
/// Rupee amounts arrive as JSON numbers (or numeric strings from an older
/// proxy); days are IST `YYYY-MM-DD` keys.
library;

double? _num(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

double _numOr0(Object? v) => _num(v) ?? 0;

String? _str(Object? v) {
  if (v is! String) return null;
  final t = v.trim();
  return t.isEmpty ? null : t;
}

/// The newest payout, on the Earnings tab.
class LastPayout {
  const LastPayout({
    required this.amount,
    required this.paidOn,
    this.reference,
  });

  final double amount;
  final String paidOn;
  final String? reference;

  factory LastPayout.fromJson(Map<String, dynamic> j) => LastPayout(
    amount: _numOr0(j['amount']),
    paidOn: '${j['paidOn']}',
    reference: _str(j['reference']),
  );
}

/// `GET /api/rider/earnings/summary`.
///
/// today/week/month/total are what deliveries and incentives earned (a
/// reversed earning is left out). Bonuses, salary, adjustments and deductions
/// are separate all-time figures. [pending] is signed: negative means the
/// rider owes Deligro (a deduction or reversal larger than everything unpaid).
class EarningsSummary {
  const EarningsSummary({
    required this.today,
    required this.week,
    required this.month,
    required this.total,
    required this.perDeliveryAvg,
    required this.deliveriesCounted,
    required this.incentives,
    required this.bonuses,
    required this.adjustments,
    required this.deductions,
    required this.salary,
    required this.paid,
    required this.pending,
    required this.lastPayout,
  });

  final double today;
  final double week;
  final double month;
  final double total;
  final double? perDeliveryAvg;
  final int deliveriesCounted;
  final double incentives;
  final double bonuses;
  final double adjustments;
  final double deductions;
  final double salary;
  final double paid;
  final double pending;
  final LastPayout? lastPayout;

  factory EarningsSummary.fromJson(Map<String, dynamic> j) => EarningsSummary(
    today: _numOr0(j['today']),
    week: _numOr0(j['week']),
    month: _numOr0(j['month']),
    total: _numOr0(j['total']),
    perDeliveryAvg: _num(j['perDeliveryAvg']),
    deliveriesCounted: _numOr0(j['deliveriesCounted']).round(),
    incentives: _numOr0(j['incentives']),
    bonuses: _numOr0(j['bonuses']),
    adjustments: _numOr0(j['adjustments']),
    deductions: _numOr0(j['deductions']),
    salary: _numOr0(j['salary']),
    paid: _numOr0(j['paid']),
    pending: _numOr0(j['pending']),
    lastPayout: j['lastPayout'] is Map
        ? LastPayout.fromJson(Map<String, dynamic>.from(j['lastPayout'] as Map))
        : null,
  );
}

enum RecordKind { delivery, incentive, bonus, adjustment, deduction, salary }

RecordKind _kind(Object? v) => RecordKind.values.firstWhere(
  (k) => k.name == v,
  orElse: () => RecordKind.adjustment,
);

/// How a delivery's distance was measured: routed (`road`), straight line x 1.3
/// (`estimate`), or not at all (null).
enum DistanceSource { road, estimate }

DistanceSource? _source(Object? v) => switch (v) {
  'road' => DistanceSource.road,
  'estimate' => DistanceSource.estimate,
  _ => null,
};

/// One line of the rider's money: a delivery's earning, an incentive award, a
/// bonus, salary, an adjustment (including the automatic reversal of a
/// corrected delivery) or a deduction.
class EarningRecord {
  const EarningRecord({
    required this.kind,
    required this.id,
    this.orderId,
    this.orderCode,
    required this.date,
    this.baseFee,
    this.distanceKm,
    this.distanceSource,
    this.distanceFee,
    this.minTopup,
    this.tip,
    this.tipInCash,
    this.incentive,
    this.deduction,
    required this.amount,
    required this.paid,
    this.settledOn,
    this.reference,
    this.note,
    this.reversed = false,
    this.reversesId,
  });

  final RecordKind kind;
  final String id;
  final String? orderId;

  /// `#A1B2C3`, or null for a record with no order.
  final String? orderCode;
  final String date;
  final double? baseFee;
  final double? distanceKm;
  final DistanceSource? distanceSource;
  final double? distanceFee;
  final double? minTopup;
  final double? tip;
  final bool? tipInCash;
  final double? incentive;
  final double? deduction;

  /// Signed: a deduction or a reversal is negative.
  final double amount;
  final bool paid;
  final String? settledOn;
  final String? reference;

  /// An incentive's rule name, an adjustment's or deduction's reason.
  final String? note;

  /// A delivery whose earning was reversed by a staff correction.
  final bool reversed;

  /// Set on the automatic reversal: the earning it takes back.
  final String? reversesId;

  /// The system's own reversal of a corrected delivery.
  bool get isReversal => kind == RecordKind.adjustment && reversesId != null;

  /// Whether the row is money the rider sees as a line. Riders are on a fixed
  /// salary (ruling P3-R11): a delivery's ₹0 earning row only counts the
  /// delivery towards incentive targets, and its ₹0 reversal likewise, so
  /// neither is listed. A per-delivery row with a real amount still is.
  bool get isMoneyLine =>
      !((kind == RecordKind.delivery || isReversal) && amount == 0);

  factory EarningRecord.fromJson(Map<String, dynamic> j) => EarningRecord(
    kind: _kind(j['kind']),
    id: '${j['id']}',
    orderId: _str(j['orderId']),
    orderCode: _str(j['orderCode']),
    date: '${j['date']}',
    baseFee: _num(j['baseFee']),
    distanceKm: _num(j['distanceKm']),
    distanceSource: _source(j['distanceSource']),
    distanceFee: _num(j['distanceFee']),
    minTopup: _num(j['minTopup']),
    tip: _num(j['tip']),
    tipInCash: j['tipInCash'] is bool ? j['tipInCash'] as bool : null,
    incentive: _num(j['incentive']),
    deduction: _num(j['deduction']),
    amount: _numOr0(j['amount']),
    paid: j['status'] == 'paid',
    settledOn: _str(j['settledOn']),
    reference: _str(j['reference']),
    note: _str(j['note']),
    reversed: j['reversed'] == true,
    reversesId: _str(j['reversesId']),
  );

  /// What the row is called in lists, statements and the CSV.
  String get title {
    if (isReversal) return 'Automatic reversal — the delivery was corrected';
    final code = orderCode;
    return switch (kind) {
      RecordKind.delivery => code == null ? 'Delivery' : 'Delivery $code',
      RecordKind.incentive => note == null ? 'Incentive' : 'Incentive — $note',
      RecordKind.bonus => note == null ? 'Bonus' : 'Bonus — $note',
      RecordKind.salary => note == null ? 'Salary' : 'Salary — $note',
      RecordKind.adjustment =>
        note == null ? 'Adjustment' : 'Adjustment — $note',
      RecordKind.deduction => note == null ? 'Deduction' : 'Deduction — $note',
    };
  }

  /// "Delivery", "Incentive", … for the CSV's type column.
  String get kindLabel => isReversal
      ? 'Reversal'
      : switch (kind) {
          RecordKind.delivery => 'Delivery',
          RecordKind.incentive => 'Incentive',
          RecordKind.bonus => 'Bonus',
          RecordKind.adjustment => 'Adjustment',
          RecordKind.deduction => 'Deduction',
          RecordKind.salary => 'Salary',
        };
}

/// One page of `GET /api/rider/earnings/records`.
class RecordsPage {
  const RecordsPage({required this.items, this.nextCursor});

  final List<EarningRecord> items;
  final String? nextCursor;

  factory RecordsPage.fromJson(Map<String, dynamic> j) => RecordsPage(
    items: [
      for (final e in (j['items'] as List? ?? const []))
        if (e is Map) EarningRecord.fromJson(Map<String, dynamic>.from(e)),
    ],
    nextCursor: _str(j['nextCursor']),
  );
}

/// `GET /api/rider/earnings/payouts` — one payout and how many records it settled.
class Payout {
  const Payout({
    required this.id,
    required this.amount,
    required this.method,
    this.reference,
    required this.paidOn,
    required this.periodEnd,
    required this.items,
  });

  final String id;
  final double amount;
  final String method;
  final String? reference;
  final String paidOn;
  final String periodEnd;
  final int items;

  factory Payout.fromJson(Map<String, dynamic> j) => Payout(
    id: '${j['id']}',
    amount: _numOr0(j['amount']),
    method: '${j['method'] ?? ''}',
    reference: _str(j['reference']),
    paidOn: '${j['paidOn']}',
    periodEnd: '${j['periodEnd']}',
    items: _numOr0(j['items']).round(),
  );

  /// "Bank transfer", "UPI", "Cash".
  String get methodLabel => switch (method) {
    'bank' || 'bank_transfer' => 'Bank transfer',
    'upi' => 'UPI',
    'cash' => 'Cash',
    '' => 'Payout',
    final m => '${m[0].toUpperCase()}${m.substring(1).replaceAll('_', ' ')}',
  };
}

/// `GET /api/rider/earnings/incentives` — one rule in force today and the
/// rider's progress in the current period.
class IncentiveProgress {
  const IncentiveProgress({
    required this.ruleId,
    required this.name,
    required this.period,
    required this.target,
    required this.done,
    required this.bonus,
    this.window,
    this.endsOn,
    required this.earned,
  });

  final String ruleId;
  final String name;

  /// `daily` or `weekly`.
  final String period;
  final int target;
  final int done;
  final double bonus;

  /// "12:00–15:00" (IST), or null for all day.
  final String? window;
  final String? endsOn;
  final bool earned;

  bool get daily => period == 'daily';

  /// 0..1 for the bar; full once earned.
  double get fraction =>
      earned || target <= 0 ? 1 : (done / target).clamp(0, 1).toDouble();

  factory IncentiveProgress.fromJson(Map<String, dynamic> j) =>
      IncentiveProgress(
        ruleId: '${j['ruleId']}',
        name: '${j['name'] ?? ''}',
        period: '${j['period'] ?? 'daily'}',
        target: _numOr0(j['target']).round(),
        done: _numOr0(j['done']).round(),
        bonus: _numOr0(j['bonus']),
        window: _str(j['window']),
        endsOn: _str(j['endsOn']),
        earned: j['earned'] == true,
      );
}

/// `GET /api/rider/earnings/statement`: opening pending + earned − paid =
/// closing pending, and every record dated in the range, oldest first.
class Statement {
  const Statement({
    this.riderCode,
    this.name,
    required this.from,
    required this.to,
    required this.openingPending,
    required this.earned,
    required this.paid,
    required this.closingPending,
    required this.rows,
  });

  final String? riderCode;
  final String? name;
  final String from;
  final String to;
  final double openingPending;
  final double earned;
  final double paid;
  final double closingPending;
  final List<EarningRecord> rows;

  /// [rows] without the ₹0 delivery rows (see [EarningRecord.isMoneyLine]).
  List<EarningRecord> get lines => [
    for (final r in rows)
      if (r.isMoneyLine) r,
  ];

  factory Statement.fromJson(Map<String, dynamic> j) => Statement(
    riderCode: _str(j['riderCode']),
    name: _str(j['name']),
    from: '${j['from']}',
    to: '${j['to']}',
    openingPending: _numOr0(j['openingPending']),
    earned: _numOr0(j['earned']),
    paid: _numOr0(j['paid']),
    closingPending: _numOr0(j['closingPending']),
    rows: [
      for (final e in (j['rows'] as List? ?? const []))
        if (e is Map) EarningRecord.fromJson(Map<String, dynamic>.from(e)),
    ],
  );
}
